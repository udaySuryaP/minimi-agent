-- 00002_create_conversations.sql
-- Conversation threads owned by users

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'New Conversation',
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Foreign key & temporal index
create index if not exists conversations_user_id_idx
  on public.conversations(user_id);

create index if not exists conversations_user_created_at_idx
  on public.conversations(user_id, created_at desc);

-- Full-text search index on title and summary
create index if not exists conversations_fts_idx
  on public.conversations using gin (to_tsvector('english', title || ' ' || coalesce(summary, '')));

create or replace trigger handle_conversations_updated_at
  before update on public.conversations
  for each row execute function public.handle_updated_at();
