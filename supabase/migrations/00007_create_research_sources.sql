-- 00007_create_research_sources.sql
-- Sources backing research claims from Tavily web searches

create table if not exists public.research_sources (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.research_claims(id) on delete cascade,
  url text not null,
  title text,
  snippet text,
  domain text,
  score real,
  published_at timestamptz,
  retrieved_at timestamptz not null default now()
);

-- Foreign key & URL lookup indexes
create index if not exists research_sources_claim_id_idx
  on public.research_sources(claim_id);

create index if not exists research_sources_url_idx
  on public.research_sources(url);
