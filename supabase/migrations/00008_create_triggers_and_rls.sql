-- 00008_create_triggers_and_rls.sql
-- Ownership consistency triggers, snapshot immutability enforcement, and Row Level Security policies

-- ==============================================================================
-- 1. Ownership and Referential Consistency Triggers
-- Prevents denormalized user_id drift and cross-conversation message references
-- ==============================================================================

-- Enforce message ownership and immutable conversation assignment
create or replace function public.enforce_message_ownership()
returns trigger
language plpgsql
as $$
declare
  v_conv_user_id uuid;
begin
  select user_id into v_conv_user_id
  from public.conversations
  where id = new.conversation_id;

  if v_conv_user_id is null then
    raise exception 'Target conversation does not exist';
  end if;

  if new.user_id is distinct from v_conv_user_id then
    raise exception 'message user_id must match conversation user_id';
  end if;

  if tg_op = 'UPDATE' and new.conversation_id is distinct from old.conversation_id then
    raise exception 'Cannot reassign message to a different conversation';
  end if;

  return new;
end;
$$;

create or replace trigger check_message_ownership
  before insert or update on public.messages
  for each row execute function public.enforce_message_ownership();

-- Enforce memory_item ownership and ensure referenced message belongs to the same conversation and user
create or replace function public.enforce_memory_item_ownership()
returns trigger
language plpgsql
as $$
declare
  v_conv_user_id uuid;
  v_msg_conv_id uuid;
  v_msg_user_id uuid;
begin
  select user_id into v_conv_user_id
  from public.conversations
  where id = new.conversation_id;

  if v_conv_user_id is null then
    raise exception 'Target conversation does not exist';
  end if;

  if new.user_id is distinct from v_conv_user_id then
    raise exception 'memory_item user_id must match conversation user_id';
  end if;

  if tg_op = 'UPDATE' and new.conversation_id is distinct from old.conversation_id then
    raise exception 'Cannot reassign memory item to a different conversation';
  end if;

  -- Verify optional message_id reference matches conversation and user
  if new.message_id is not null then
    select conversation_id, user_id into v_msg_conv_id, v_msg_user_id
    from public.messages
    where id = new.message_id;

    if v_msg_conv_id is null then
      raise exception 'Referenced message does not exist';
    end if;

    if v_msg_conv_id is distinct from new.conversation_id then
      raise exception 'Referenced message must belong to the same conversation as the memory item';
    end if;

    if v_msg_user_id is distinct from new.user_id then
      raise exception 'Referenced message must belong to the same user as the memory item';
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger check_memory_item_ownership
  before insert or update on public.memory_items
  for each row execute function public.enforce_memory_item_ownership();

-- Enforce research_snapshot ownership and ensure optional trigger message belongs to the same conversation and user
create or replace function public.enforce_snapshot_ownership()
returns trigger
language plpgsql
as $$
declare
  v_conv_user_id uuid;
  v_msg_conv_id uuid;
  v_msg_user_id uuid;
begin
  select user_id into v_conv_user_id
  from public.conversations
  where id = new.conversation_id;

  if v_conv_user_id is null then
    raise exception 'Target conversation does not exist';
  end if;

  if new.user_id is distinct from v_conv_user_id then
    raise exception 'research_snapshot user_id must match conversation user_id';
  end if;

  if tg_op = 'UPDATE' and new.conversation_id is distinct from old.conversation_id then
    raise exception 'Cannot reassign research snapshot to a different conversation';
  end if;

  -- Verify optional trigger_message_id reference matches conversation and user
  if new.trigger_message_id is not null then
    select conversation_id, user_id into v_msg_conv_id, v_msg_user_id
    from public.messages
    where id = new.trigger_message_id;

    if v_msg_conv_id is null then
      raise exception 'Referenced trigger message does not exist';
    end if;

    if v_msg_conv_id is distinct from new.conversation_id then
      raise exception 'Referenced trigger message must belong to the same conversation as the snapshot';
    end if;

    if v_msg_user_id is distinct from new.user_id then
      raise exception 'Referenced trigger message must belong to the same user as the snapshot';
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger check_snapshot_ownership
  before insert or update on public.research_snapshots
  for each row execute function public.enforce_snapshot_ownership();

-- ==============================================================================
-- 2. Snapshot Immutability Triggers
-- Enforces that finalized snapshots (completed, failed, partial) cannot be modified or deleted,
-- and that claims/sources cannot be added, edited, or deleted once finalized.
-- ==============================================================================

create or replace function public.enforce_snapshot_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status in ('completed', 'failed', 'partial') then
      raise exception 'Completed or finalized research snapshots are immutable';
    end if;

    -- While in pending state, prevent mutating core identity and query attributes
    if new.id is distinct from old.id or
       new.user_id is distinct from old.user_id or
       new.conversation_id is distinct from old.conversation_id or
       new.query is distinct from old.query or
       new.created_at is distinct from old.created_at then
      raise exception 'Cannot modify snapshot identity, conversation, query, or creation timestamp';
    end if;
  elsif tg_op = 'DELETE' then
    if old.status in ('completed', 'failed', 'partial') then
      raise exception 'Completed or finalized research snapshots cannot be deleted';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

create or replace trigger check_snapshot_immutability
  before update or delete on public.research_snapshots
  for each row execute function public.enforce_snapshot_immutability();

create or replace function public.enforce_claims_and_sources_immutability()
returns trigger
language plpgsql
as $$
declare
  v_status text;
  v_snapshot_id uuid;
begin
  if tg_table_name = 'research_claims' then
    v_snapshot_id := case when tg_op = 'DELETE' then old.snapshot_id else new.snapshot_id end;
  elsif tg_table_name = 'research_sources' then
    select snapshot_id into v_snapshot_id
    from public.research_claims
    where id = case when tg_op = 'DELETE' then old.claim_id else new.claim_id end;
  end if;

  select status into v_status
  from public.research_snapshots
  where id = v_snapshot_id;

  if v_status in ('completed', 'failed', 'partial') then
    raise exception 'Cannot add, modify, or delete claims or sources for a finalized research snapshot';
  end if;

  return coalesce(new, old);
end;
$$;

create or replace trigger check_claims_immutability
  before insert or update or delete on public.research_claims
  for each row execute function public.enforce_claims_and_sources_immutability();

create or replace trigger check_sources_immutability
  before insert or update or delete on public.research_sources
  for each row execute function public.enforce_claims_and_sources_immutability();

-- ==============================================================================
-- 3. Enable Row Level Security (RLS) on all tables
-- ==============================================================================

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.memory_items enable row level security;
alter table public.research_snapshots enable row level security;
alter table public.research_claims enable row level security;
alter table public.research_sources enable row level security;

-- ==============================================================================
-- 4. Profiles Policies
-- ==============================================================================

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ==============================================================================
-- 5. Conversations Policies
-- ==============================================================================

create policy "conversations_select_own"
  on public.conversations for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "conversations_insert_own"
  on public.conversations for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "conversations_update_own"
  on public.conversations for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "conversations_delete_own"
  on public.conversations for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ==============================================================================
-- 6. Messages Policies
-- ==============================================================================

create policy "messages_select_own"
  on public.messages for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "messages_insert_own"
  on public.messages for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "messages_update_own"
  on public.messages for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "messages_delete_own"
  on public.messages for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ==============================================================================
-- 7. Memory Items Policies
-- ==============================================================================

create policy "memory_items_select_own"
  on public.memory_items for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "memory_items_insert_own"
  on public.memory_items for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "memory_items_update_own"
  on public.memory_items for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "memory_items_delete_own"
  on public.memory_items for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ==============================================================================
-- 8. Research Snapshots Policies (Immutable Snapshot Lifecycle)
-- Users can insert pending snapshots, complete them once, and never update or delete completed ones.
-- ==============================================================================

create policy "research_snapshots_select_own"
  on public.research_snapshots for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "research_snapshots_insert_pending"
  on public.research_snapshots for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'pending'
  );

create policy "research_snapshots_update_lifecycle"
  on public.research_snapshots for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and status = 'pending'
  )
  with check (
    (select auth.uid()) = user_id
    and status in ('completed', 'failed', 'partial')
  );

create policy "research_snapshots_delete_pending_only"
  on public.research_snapshots for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and status = 'pending'
  );

-- ==============================================================================
-- 9. Research Claims Policies
-- Claims can be inserted, updated, or removed ONLY while the parent snapshot is pending.
-- ==============================================================================

create policy "research_claims_select_own"
  on public.research_claims for select
  to authenticated
  using (
    exists (
      select 1 from public.research_snapshots s
      where s.id = snapshot_id
      and s.user_id = (select auth.uid())
    )
  );

create policy "research_claims_insert_pending"
  on public.research_claims for insert
  to authenticated
  with check (
    exists (
      select 1 from public.research_snapshots s
      where s.id = snapshot_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  );

create policy "research_claims_update_pending"
  on public.research_claims for update
  to authenticated
  using (
    exists (
      select 1 from public.research_snapshots s
      where s.id = snapshot_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  )
  with check (
    exists (
      select 1 from public.research_snapshots s
      where s.id = snapshot_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  );

create policy "research_claims_delete_pending"
  on public.research_claims for delete
  to authenticated
  using (
    exists (
      select 1 from public.research_snapshots s
      where s.id = snapshot_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  );

-- ==============================================================================
-- 10. Research Sources Policies
-- Sources can be inserted, updated, or removed ONLY while the parent snapshot is pending.
-- ==============================================================================

create policy "research_sources_select_own"
  on public.research_sources for select
  to authenticated
  using (
    exists (
      select 1 from public.research_claims c
      join public.research_snapshots s on s.id = c.snapshot_id
      where c.id = claim_id
      and s.user_id = (select auth.uid())
    )
  );

create policy "research_sources_insert_pending"
  on public.research_sources for insert
  to authenticated
  with check (
    exists (
      select 1 from public.research_claims c
      join public.research_snapshots s on s.id = c.snapshot_id
      where c.id = claim_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  );

create policy "research_sources_update_pending"
  on public.research_sources for update
  to authenticated
  using (
    exists (
      select 1 from public.research_claims c
      join public.research_snapshots s on s.id = c.snapshot_id
      where c.id = claim_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  )
  with check (
    exists (
      select 1 from public.research_claims c
      join public.research_snapshots s on s.id = c.snapshot_id
      where c.id = claim_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  );

create policy "research_sources_delete_pending"
  on public.research_sources for delete
  to authenticated
  using (
    exists (
      select 1 from public.research_claims c
      join public.research_snapshots s on s.id = c.snapshot_id
      where c.id = claim_id
      and s.user_id = (select auth.uid())
      and s.status = 'pending'
    )
  );
