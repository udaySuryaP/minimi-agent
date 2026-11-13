-- 00006_create_research_claims.sql
-- Structured claims extracted from research snapshots
-- Bi-temporal: valid_at indicates when claim was true, recorded_at indicates when stored

create table if not exists public.research_claims (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.research_snapshots(id) on delete cascade,
  entity_name text not null,
  claim_type text not null check (claim_type in ('pricing', 'feature', 'announcement', 'comparison', 'general')),
  claim_text text not null,
  claim_value text,
  structured_data jsonb not null default '{}'::jsonb,
  valid_at timestamptz,
  recorded_at timestamptz not null default now()
);

-- Foreign key & entity matching indexes
create index if not exists research_claims_snapshot_id_idx
  on public.research_claims(snapshot_id);

create index if not exists research_claims_entity_type_idx
  on public.research_claims(lower(entity_name), claim_type);
