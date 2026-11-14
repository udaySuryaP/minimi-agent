-- Atomic authenticated persistence, ranked historical search, and function hardening.
-- All RPCs deliberately use SECURITY INVOKER: caller RLS and table privileges remain active.

-- Make the app tables reachable by authenticated clients while retaining their RLS policies.
grant usage on schema public to authenticated;
grant select, insert, update, delete on table
  public.profiles,
  public.conversations,
  public.messages,
  public.memory_items,
  public.research_snapshots,
  public.research_claims,
  public.research_sources
to authenticated;

-- Remove the accidental HTTP/RPC surface for privileged and trigger-only helpers.
revoke all on function public.rls_auto_enable() from public;
revoke all on function public.handle_new_user() from public;

create or replace function public.persist_research_snapshot(
  p_conversation_id uuid,
  p_query text,
  p_search_params jsonb,
  p_claims jsonb,
  p_status text,
  p_completed_at timestamptz
)
returns table(snapshot_id uuid, conversation_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_conversation_id uuid := p_conversation_id;
  v_snapshot_id uuid;
  v_claim jsonb;
  v_source jsonb;
  v_claim_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_query is null or btrim(p_query) = '' or length(p_query) > 4000 then
    raise exception 'query must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if p_search_params is null or jsonb_typeof(p_search_params) <> 'object' then
    raise exception 'search_params must be a JSON object' using errcode = '22023';
  end if;
  if p_claims is null or jsonb_typeof(p_claims) <> 'array' then
    raise exception 'claims must be a JSON array' using errcode = '22023';
  end if;
  if p_status not in ('completed', 'failed', 'partial') then
    raise exception 'status must be completed, failed, or partial' using errcode = '22023';
  end if;
  if p_completed_at is null then
    raise exception 'completed_at is required' using errcode = '22023';
  end if;

  if v_conversation_id is null then
    insert into public.conversations (user_id, title)
    values (v_user_id, left(p_query, 120))
    returning id into v_conversation_id;
  elsif not exists (
    select 1 from public.conversations c
    where c.id = v_conversation_id and c.user_id = v_user_id
  ) then
    raise exception 'conversation is not accessible to the current user' using errcode = '42501';
  end if;

  insert into public.research_snapshots (user_id, conversation_id, query, status, search_params)
  values (v_user_id, v_conversation_id, p_query, 'pending', p_search_params)
  returning id into v_snapshot_id;

  for v_claim in select value from jsonb_array_elements(p_claims)
  loop
    if jsonb_typeof(v_claim) <> 'object'
       or nullif(btrim(v_claim->>'entity_name'), '') is null
       or nullif(btrim(v_claim->>'claim_text'), '') is null
       or coalesce(v_claim->>'claim_type', '') not in ('pricing', 'feature', 'announcement', 'comparison', 'general')
       or (v_claim ? 'sources' and jsonb_typeof(v_claim->'sources') <> 'array') then
      raise exception 'invalid claim payload' using errcode = '22023';
    end if;

    insert into public.research_claims (
      snapshot_id, entity_name, claim_type, claim_text, claim_value, structured_data, valid_at
    ) values (
      v_snapshot_id,
      v_claim->>'entity_name',
      v_claim->>'claim_type',
      v_claim->>'claim_text',
      nullif(v_claim->>'claim_value', ''),
      coalesce(v_claim->'structured_data', '{}'::jsonb),
      nullif(v_claim->>'valid_at', '')::timestamptz
    ) returning id into v_claim_id;

    for v_source in select value from jsonb_array_elements(coalesce(v_claim->'sources', '[]'::jsonb))
    loop
      if jsonb_typeof(v_source) <> 'object'
         or coalesce(v_source->>'url', '') !~ '^https?://[^[:space:]]+$' then
        raise exception 'invalid source URL' using errcode = '22023';
      end if;
      insert into public.research_sources (
        claim_id, url, title, snippet, domain, score, published_at
      ) values (
        v_claim_id, v_source->>'url', nullif(v_source->>'title', ''),
        nullif(v_source->>'snippet', ''), nullif(v_source->>'domain', ''),
        nullif(v_source->>'score', '')::real, nullif(v_source->>'published_at', '')::timestamptz
      );
    end loop;
  end loop;

  update public.research_snapshots
  set status = p_status, completed_at = greatest(p_completed_at, created_at)
  where id = v_snapshot_id;

  return query select v_snapshot_id, v_conversation_id;
end;
$$;

-- Existing owner B-tree indexes combine with these GIN indexes through bitmap scans.
create index if not exists memory_items_fts_full_idx
  on public.memory_items using gin (to_tsvector('english', entity_name || ' ' || content));

create or replace function public.search_historical(
  p_query text,
  p_conversation_id uuid default null,
  p_limit integer default 24
)
returns table(kind text, id uuid, rank real)
language sql
security invoker
set search_path = ''
stable
as $$
  with params as (
    select websearch_to_tsquery('english', p_query) as query,
           least(greatest(p_limit, 1), 100) as row_limit
  ), ranked as (
    select 'message'::text as kind, m.id,
      ts_rank_cd(to_tsvector('english', m.content), params.query)::real as rank
    from public.messages m cross join params
    where p_query is not null and btrim(p_query) <> ''
      and (p_conversation_id is null or m.conversation_id = p_conversation_id)
      and to_tsvector('english', m.content) @@ params.query
    union all
    select 'memory_item', mi.id,
      ts_rank_cd(to_tsvector('english', mi.entity_name || ' ' || mi.content), params.query)::real
    from public.memory_items mi cross join params
    where p_query is not null and btrim(p_query) <> ''
      and (p_conversation_id is null or mi.conversation_id = p_conversation_id)
      and to_tsvector('english', mi.entity_name || ' ' || mi.content) @@ params.query
    union all
    select 'research_snapshot', rs.id,
      ts_rank_cd(to_tsvector('english', rs.query), params.query)::real
    from public.research_snapshots rs cross join params
    where p_query is not null and btrim(p_query) <> '' and rs.status = 'completed'
      and (p_conversation_id is null or rs.conversation_id = p_conversation_id)
      and to_tsvector('english', rs.query) @@ params.query
  )
  select ranked.kind, ranked.id, ranked.rank
  from ranked cross join params
  order by ranked.rank desc, ranked.id
  limit (select row_limit from params);
$$;

revoke all on function public.persist_research_snapshot(uuid, text, jsonb, jsonb, text, timestamptz) from public;
revoke all on function public.search_historical(text, uuid, integer) from public;
grant execute on function public.persist_research_snapshot(uuid, text, jsonb, jsonb, text, timestamptz) to authenticated;
grant execute on function public.search_historical(text, uuid, integer) to authenticated;
