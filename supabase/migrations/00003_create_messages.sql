-- 00003_create_messages.sql
-- Individual messages within a conversation
-- Note: event_at is omitted per refined bi-temporal design; event time belongs on memory items & claims

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint messages_id_conv_key unique (id, conversation_id),
  constraint messages_id_conv_user_key unique (id, conversation_id, user_id)
);

-- Foreign key indexes
create index if not exists messages_conversation_id_idx
  on public.messages(conversation_id);

create index if not exists messages_user_id_idx
  on public.messages(user_id);

-- Temporal ordering indexes
create index if not exists messages_conversation_created_at_idx
  on public.messages(conversation_id, created_at asc);

create index if not exists messages_user_created_at_idx
  on public.messages(user_id, created_at desc);

-- Full-text search index on message content
create index if not exists messages_fts_idx
  on public.messages using gin (to_tsvector('english', content));
