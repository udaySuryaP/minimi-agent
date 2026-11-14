-- Trigger helpers are not part of the public RPC surface; pin their resolution context.
alter function public.handle_updated_at() set search_path = '';
alter function public.enforce_message_ownership() set search_path = '';
alter function public.enforce_memory_item_ownership() set search_path = '';
alter function public.enforce_snapshot_ownership() set search_path = '';
alter function public.enforce_snapshot_immutability() set search_path = '';
alter function public.enforce_claims_and_sources_immutability() set search_path = '';

revoke all on function public.handle_updated_at() from public;
revoke all on function public.enforce_message_ownership() from public;
revoke all on function public.enforce_memory_item_ownership() from public;
revoke all on function public.enforce_snapshot_ownership() from public;
revoke all on function public.enforce_snapshot_immutability() from public;
revoke all on function public.enforce_claims_and_sources_immutability() from public;

create index if not exists research_snapshots_fts_idx
  on public.research_snapshots using gin (to_tsvector('english', query));
