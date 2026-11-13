-- 00004_create_memory_items.sql
-- Structured memory items capturing entities, facts, and decisions
-- Bi-temporal: valid_from/valid_to capture valid event time, created_at captures recorded time

create table if not exists public.memory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  entity_type text not null check (entity_type in ('product', 'company', 'decision', 'fact', 'preference', 'topic', 'other')),
  entity_name text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  constraint memory_items_valid_time_order check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

-- Foreign key indexes
create index if not exists memory_items_user_id_idx
  on public.memory_items(user_id);

create index if not exists memory_items_conversation_id_idx
  on public.memory_items(conversation_id);

create index if not exists memory_items_message_id_idx
  on public.memory_items(message_id);

-- Entity & temporal retrieval indexes
create index if not exists memory_items_user_entity_name_idx
  on public.memory_items(user_id, lower(entity_name));

create index if not exists memory_items_user_entity_type_idx
  on public.memory_items(user_id, entity_type);

create index if not exists memory_items_user_valid_from_idx
  on public.memory_items(user_id, valid_from desc);

-- Full-text search index on content
create index if not exists memory_items_fts_idx
  on public.memory_items using gin (to_tsvector('english', content));
