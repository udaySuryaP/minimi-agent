-- 00005_create_research_snapshots.sql
-- Immutable research snapshots capturing point-in-time web research runs
-- Snapshots start in 'pending' status and transition once to 'completed' (or 'failed'/'partial').
-- Once finalized, snapshots cannot be updated or deleted.

create table if not exists public.research_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  trigger_message_id uuid references public.messages(id) on delete set null,
  query text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed', 'partial')),
  search_params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint research_snapshots_completed_after_created check (completed_at is null or completed_at >= created_at)
);

-- Foreign key indexes
create index if not exists research_snapshots_user_id_idx
  on public.research_snapshots(user_id);

create index if not exists research_snapshots_conversation_id_idx
  on public.research_snapshots(conversation_id);

create index if not exists research_snapshots_trigger_message_id_idx
  on public.research_snapshots(trigger_message_id);

-- Temporal retrieval index
create index if not exists research_snapshots_conv_created_idx
  on public.research_snapshots(conversation_id, created_at desc);
