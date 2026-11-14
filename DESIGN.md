# Minimi Design Summary

## Purpose

Minimi is an authenticated temporal-memory research agent. It retrieves the signed-in user's historical records, resolves time references in the user's timezone, performs bounded current web research when needed, and returns evidence-grounded findings with citations.

## Request flow

`/chat` submits only `{ query, conversationId? }` to the same-origin `POST /api/agent` route. The route reads the session with the publishable Supabase client, validates and bounds the request body, loads the user's timezone, and runs deterministic orchestration. Browser code never receives provider credentials or accesses Supabase tables directly.

The orchestrator resolves temporal ambiguity before retrieval, retrieves only owner-scoped completed research, creates a bounded Tavily plan, validates and limits search results, extracts claims, checks claims and answer findings against supplied source text, and persists a finalized snapshot through the authenticated Supabase RPC. Provider, retrieval, and persistence failures become safe partial or failed states rather than fabricated answers.

## Data and security boundaries

- Supabase RLS remains the database ownership boundary for user data.
- The persistence RPC is `SECURITY INVOKER`, validates its inputs, and runs with a pinned empty search path.
- User queries, search titles, snippets, and model output are treated as untrusted data; model instructions explicitly separate data from instructions.
- Zod schemas validate request, provider, search, evidence, and response shapes. Citation IDs must resolve to supplied sources.
- Request bodies, search calls, search results, provider inputs, and provider timeouts are bounded.
- Finalized research evidence is immutable under the existing migrations; no schema or migration changes were made for Phase 4 audit work.

## Provider status

OpenRouter is the active and validated reasoning path. Gemini remains a server-only compatibility path, but the live Gemini route was unavailable during validation and is therefore unverified. Tavily is the sole web-search provider.

## Known residual risks

The API has no distributed rate limiter or durable idempotency key. Per-request ceilings limit individual Tavily/model work, but deployment-level abuse controls and duplicate-request suppression remain before treating the service as fully production-hardened. Pending snapshot cleanup is owner-scoped and failure-aware, but there is no automatic orphan sweeper. Database-level RLS and trigger verification still requires a safe test database; production data was not used for this audit.

## Audit outcome

The existing UI/API/agent path passed lint, TypeScript, 175 unit tests, production build, and whitespace diff checks after the focused reliability and documentation updates. No branch changes, migrations, schema changes, ModuleWyse changes, production-data access, or destructive operations were performed.
