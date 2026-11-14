# Minimi — Temporal Memory Research Agent

Minimi is an AI-powered conversational research agent that remembers past research, retrieves historical conversations by date, and compares historical findings against current web sources.

## Architecture Overview

Minimi is designed as a modular monolith built with:
- **Framework:** Next.js 16 (App Router with React 19 and TypeScript)
- **Styling:** Tailwind CSS v4 with PostCSS
- **Database & Auth:** Supabase PostgreSQL with Row Level Security (RLS)
- **Reasoning:** OpenRouter HTTP API (active validated route); Gemini HTTP compatibility path is retained but unverified/unavailable in the current validation environment
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
- An [OpenRouter](https://openrouter.ai) API key and explicit model ID (active provider path)
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
| `OPENROUTER_API_KEY` | OpenRouter API key for reasoning and generation (active provider path) | [OpenRouter Keys](https://openrouter.ai/settings/keys) |
| `OPENROUTER_MODEL` | Required when OpenRouter is used; explicit model ID, with no automatic free-model default | [OpenRouter models](https://openrouter.ai/models) |
| `OPENROUTER_FALLBACK_MODEL` | Optional single bounded fallback model for provider failures | Optional server-only setting |
| `OPENROUTER_CLASSIFICATION_MODEL`, `OPENROUTER_EXTRACTION_MODEL`, `OPENROUTER_ANSWER_MODEL`, `OPENROUTER_VERIFICATION_MODEL` | Optional per-operation overrides; fall back to `OPENROUTER_MODEL` | Optional server-only settings |
| `OPENROUTER_EXTRACTION_TIMEOUT_MS` | Claim extraction timeout, bounded to 3–30 seconds (default `15000`) | Optional server-only setting |
| `GEMINI_API_KEY` | Optional Gemini compatibility/fallback key; the Gemini route is unverified and currently unavailable in validation | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `TAVILY_API_KEY` | Tavily Search Key (Phase 2) | [Tavily Dashboard](https://app.tavily.com) |
| `AGENT_MAX_REQUEST_BYTES` | Maximum `/api/agent` request body size in bytes (default `16384`; values above `1048576` use the default) | Optional server-only setting |
| `AGENT_MAX_SEARCH_CALLS` | Per-turn Tavily call ceiling (default `8`; hard maximum `8`) | Optional server-only setting |
| `AGENT_MAX_RESULTS_PER_CALL` | Tavily results requested per call (default `5`; hard maximum `5`) | Optional server-only setting |
| `AGENT_SEARCH_CALL_TIMEOUT_MS` | Timeout for one Tavily call (default and hard maximum `8000`) | Optional server-only setting |
| `AGENT_SEARCH_TOTAL_TIMEOUT_MS` | Total Tavily execution budget (default and hard maximum `30000`) | Optional server-only setting |
| `NEXT_PUBLIC_APP_URL` | Base application URL | `http://localhost:3000` for local dev |

> **Security Note:** Never commit `.env.local`. It is strictly excluded by `.gitignore`.

The search plan carries an intended call budget, and the server-side executor independently enforces the configured per-turn and per-call limits. Limits can be lowered with the server-only environment variables above; values cannot raise the hard caps.

OpenRouter is the active reasoning provider path. Gemini remains a server-only compatibility path, but its live route was unavailable during validation and must not be described as verified production functionality. Provider availability is checked at request time; credentials are never sent to the browser.

Historical retrieval ranks at most 200 newest full-text matches per record type because the current schema exposes no database-side relevance score. A relevant record outside that candidate window may not be returned; adding a rank projection or RPC can be considered separately if observed data volume requires it.

Research comparisons require the same normalized proposition and compatible product/version dimensions. Pricing comparisons additionally require known amount, currency, billing period, region, plan, standard/promotional type, and (for promotions) matching discount conditions. When a dimension is missing, Minimi reports insufficient evidence. Extracted claims and final findings each receive at most one bounded evidence-support review using only the claim and its cited source text (at most two verification calls per run, each with an eight-second timeout). Unsupported claims are omitted or labeled insufficient/conflicting. These automated checks reduce unsupported claims but cannot guarantee factual truth.

Agent responses use `completed` when every planned search call and the answer/persistence stages succeed (including a successful search with zero results), `partial` when evidence or findings exist but extraction, answer generation, search, or persistence was incomplete, `failed` when no usable evidence or a required provider stage fails before research can begin, `no_search` when the intent does not need web research, and `needs_clarification` when time intent is ambiguous. Failed search calls and successful empty results remain distinguishable in `searchExecution.outcomes`.

Snapshot persistence uses the authenticated `persist_research_snapshot` RPC, which performs the snapshot, claim, and source writes in one database transaction. A failed RPC rolls back its writes; historical retrieval explicitly loads completed snapshots only. There is no automatic orphan sweeper for pending rows created by other administrative paths; a future maintenance task should identify aged pending rows and clean them up with owner-scoped checks, while leaving active recent runs untouched.

The current API has no distributed rate limiter and no durable idempotency key for retried requests. Tavily/model calls are bounded per request, but deployment-level abuse controls and duplicate-request suppression remain production follow-up work; do not treat the per-turn ceilings as account-level quotas.

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

### 3. Research Snapshot Immutability Lifecycle, Referential Cleanup & Account Deletion
- **Creation & Finalization:**
  - New snapshots are created in `'pending'` state with a mandatory, non-null `conversation_id`.
  - Claims and sources can only be attached while the snapshot is in `'pending'` state.
  - Upon research completion, the snapshot transitions to `'completed'`, `'failed'`, or `'partial'` with `completed_at` recorded.
  - **Finalization Integrity:** A pending snapshot cannot be detached (`conversation_id = NULL`) or reassigned to a different conversation during finalization. Both RLS `with check` (which explicitly requires `conversation_id IS NOT NULL`) and the database trigger `enforce_snapshot_immutability` enforce that finalization retains a valid conversation reference while permitting the intended pending-to-finalized transition.
- **Immutability of Finalized Evidence:**
  - Once finalized, database triggers and RLS policies strictly forbid any updates to content, query, or metadata, as well as direct deletion of snapshots, claims, or sources by users.
- **Referential Cleanup Semantics:**
  - `trigger_message_id` uses `ON DELETE SET NULL`. Deleting a referenced message sets `trigger_message_id` to `NULL` without deleting or failing the snapshot.
  - `conversation_id` uses `ON DELETE SET NULL`. Deleting a conversation sets `conversation_id` to `NULL` without deleting or failing the snapshot.
  - The snapshot immutability trigger explicitly permits these cascading referential nullings while strictly rejecting any other column modifications or direct deletions.
  - All captured research claims and sources remain intact and associated with the user profile, guaranteeing historical research preservation even if conversations are pruned.
- **Account Deletion Semantics:**
  - When an account is deleted via Supabase Auth (`DELETE FROM auth.users`), foreign key cascades propagate to `public.profiles` (`ON DELETE CASCADE`).
  - When the owning profile row has been deleted, the snapshot and claims immutability triggers recognize that account deletion is occurring and permit the cascade to cleanly remove all associated snapshots, claims, and sources.
  - If the owning profile still exists, direct deletions of finalized snapshots and claims remain completely blocked.
- **Security Boundary Between RLS and Referential Actions:**
  - PostgreSQL row-level triggers evaluate column transitions (`OLD` vs `NEW`) but cannot inspect the call stack to determine whether an update originated from an internal engine foreign-key cascade or direct SQL.
  - Ordinary authenticated users are protected at the database boundary via Row Level Security (RLS). The `research_snapshots_update_lifecycle` policy strictly requires `status = 'pending'`, making it impossible for authenticated users to execute direct `UPDATE` statements on finalized snapshots.
  - Privileged database-owner/service-role operations are restricted to server administration and are never exposed to client applications.

### 4. Safe Authentication Messaging & Timezone Sanitization
- Raw Supabase errors and internal exceptions are never leaked in URLs or rendered to users; safe generic error codes are displayed while structured diagnostics are logged on the server using `logAuthDiagnostic()`.
- Server diagnostics never log passwords, tokens, auth codes, or raw provider strings.
- Submitted timezones are validated against official IANA identifiers with a fallback to `Asia/Kolkata`.
- Route matching in `src/proxy.ts` uses boundary-aware path checking to prevent unintended prefix matches.

## Database Verification Script

To verify all schema triggers, ownership checks, snapshot immutability, referential cleanup cascades, authenticated-role RLS policies, and complete account-deletion cascades in your Supabase project, execute `supabase/verification.sql` in the **Supabase Dashboard SQL Editor** or via Supabase CLI (`supabase db query`).

### Elevated Privileges & Safety
- **Privileges:** The verification script requires administrative (`postgres` / `service_role`) privileges because it creates ephemeral test users in `auth.users` to satisfy foreign keys on `public.profiles` and tests role switching.
- **Environment:** Run in the Supabase SQL Editor or a local development PostgreSQL instance. It is not intended for client-side execution.
- **Safety:** The script runs within an atomic transaction that unconditionally ends with `ROLLBACK`. Zero test users, data, or credentials are persisted.

The verification script executes 4 distinct testing phases:
1. **Part 1: Snapshot Finalization & Immutability Integrity (Specific SQLSTATE & Message Assertions)**
   - Rejection of snapshot finalization with `conversation_id = NULL` (asserts SQLSTATE `P0001` and exact message substring).
   - Rejection of invalid snapshot lifecycle status transitions (asserts SQLSTATE `23514` check violation or `P0001`).
   - Acceptance of normal snapshot finalization with valid conversation.
   - Rejection of direct `UPDATE` on finalized snapshot content/query (asserts SQLSTATE `P0001`).
   - Rejection of direct `DELETE` on finalized snapshot while profile exists (asserts SQLSTATE `P0001`).
   - Rejection of `INSERT`, `UPDATE`, and `DELETE` on claims and sources belonging to a finalized snapshot (asserts SQLSTATE `P0001`).
2. **Part 2: Referential Cleanup on Message & Conversation Deletion**
   - Referential cleanup: deleting a referenced message sets `trigger_message_id = NULL` while snapshot remains.
   - Referential cleanup: deleting a referenced conversation sets `conversation_id = NULL` while snapshot remains.
   - Preservation of research evidence: snapshot, claims, and sources remain intact after conversation deletion.
3. **Part 3: Authenticated-Role Row Level Security (RLS) Verification**
   - Switches execution role to `authenticated` using Supabase JWT claim context (`request.jwt.claim.sub`).
   - Verifies User A can read their own permitted records under RLS.
   - Verifies User A cannot read User B's protected records (cross-tenant row filtering).
   - Verifies User A cannot mutate (UPDATE or DELETE) User B's records (`row_count = 0`).
   - Verifies User A cannot mutate their own finalized snapshots under RLS (`row_count = 0`).
   - Restores role safely back to administrative context.
4. **Part 4: Complete Account-Deletion Cascade from `auth.users`**
   - Deletes test user from `auth.users`.
   - Confirms complete cascade purges records across `profiles`, `conversations`, `messages`, `memory_items`, `research_snapshots`, `research_claims`, and `research_sources`.
