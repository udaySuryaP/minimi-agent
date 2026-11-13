# Minimi — Temporal Memory Research Agent

Minimi is an AI-powered conversational research agent that remembers past research, retrieves historical conversations by date, and compares historical findings against current web sources.

## Architecture Overview

Minimi is designed as a modular monolith built with:
- **Framework:** Next.js 16 (App Router with React 19 and TypeScript)
- **Styling:** Tailwind CSS v4 with PostCSS
- **Database & Auth:** Supabase PostgreSQL with Row Level Security (RLS)
- **Reasoning:** Google GenAI SDK (Gemini API)
- **Web Search:** Tavily Search API (the sole external search tool)
- **Validation:** Zod v4 and typed domain schemas
- **Testing:** Vitest automated test suite

The design distinguishes:
- **Recorded time (`created_at`):** When Minimi stored a record.
- **Event / valid time (`valid_at`, `valid_from`, `valid_to`):** When facts, decisions, or research claims were true.

## Prerequisites

- Node.js 20+ (Node 24 recommended)
- npm 10+
- A [Supabase](https://supabase.com) project
- A [Google AI Studio](https://aistudio.google.com) API key
- A [Tavily](https://tavily.com) API key

## Local Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd minimi-agent
npm install
```

### 2. Configure environment variables

```bash
cp .env.local.example .env.local
```

Open `.env.local` and fill in your credentials:

| Variable | Description | Where to find it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL | Supabase Dashboard → Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase Public / Anon API Key | Supabase Dashboard → Settings → API |
| `SUPABASE_SECRET_KEY` | Optional server-only secret key | Supabase Dashboard → Settings → API (service_role) |
| `GEMINI_API_KEY` | Google AI Studio Key (Phase 2) | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `TAVILY_API_KEY` | Tavily Search Key (Phase 2) | [Tavily Dashboard](https://app.tavily.com) |
| `NEXT_PUBLIC_APP_URL` | Base application URL | `http://localhost:3000` for local dev |

> **Security Note:** Never commit `.env.local`. It is strictly excluded by `.gitignore`.

### 3. Apply database migrations

> **Important:** Review all SQL files in `supabase/migrations/` before applying.

Apply migrations in numerical order (00001 to 00008) via the Supabase Dashboard SQL Editor or Supabase CLI:

1. `supabase/migrations/00001_create_profiles.sql` — Profiles and automatic signup creation trigger
2. `supabase/migrations/00002_create_conversations.sql` — Conversation threads and full-text search indexes
3. `supabase/migrations/00003_create_messages.sql` — Messages with composite integrity constraints
4. `supabase/migrations/00004_create_memory_items.sql` — Bi-temporal memory items with temporal order constraints
5. `supabase/migrations/00005_create_research_snapshots.sql` — Immutable research snapshots table
6. `supabase/migrations/00006_create_research_claims.sql` — Point-in-time claims extracted from research
7. `supabase/migrations/00007_create_research_sources.sql` — Verifiable Tavily sources backing claims
8. `supabase/migrations/00008_create_triggers_and_rls.sql` — Consistency triggers, immutability triggers, and RLS policies

### 4. Configure Supabase Auth

In the Supabase Dashboard → Authentication → URL Configuration:
- **Site URL:** `http://localhost:3000`
- **Redirect URLs:** Add `http://localhost:3000/auth/callback`

### 5. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Build for production (`next build --webpack`) |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm test` | Run Vitest unit tests |

## Security & Database Integrity Architecture

### 1. Open Redirect Prevention
Post-login and callback redirects are strictly validated via `getSafeRedirectUrl()`. Protocol-relative URLs (`//evil.com`), backslash bypasses (`/\evil.com`), external origins, and malformed strings are rejected and safely redirected to `/chat`.

### 2. Cross-Table Ownership & Referential Integrity
- `enforce_message_ownership()`: Enforces that messages belong to their parent conversation's user and cannot be moved between conversations.
- `enforce_memory_item_ownership()`: Enforces that any referenced `message_id` belongs to the exact same conversation and user.
- `enforce_snapshot_ownership()`: Enforces that any referenced `trigger_message_id` belongs to the exact same conversation and user.

### 3. Research Snapshot Immutability Lifecycle
- New snapshots are created in `'pending'` state.
- Claims and sources can only be attached while the snapshot is `'pending'`.
- Upon completion, the snapshot transitions to `'completed'`, `'failed'`, or `'partial'` with `completed_at` set.
- Once finalized, database triggers and RLS policies strictly forbid any further updates or deletions to snapshots, claims, or sources. Historical evidence remains immutable.

### 4. Safe Authentication Messaging & Timezone Sanitization
- Raw Supabase errors are never leaked in URLs or rendered to users; safe generic error codes are displayed while diagnostics are logged on the server.
- Submitted timezones are validated against official IANA identifiers with a fallback to `Asia/Kolkata`.
- Route matching in `src/proxy.ts` uses boundary-aware path checking to prevent unintended prefix matches.
