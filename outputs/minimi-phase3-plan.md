# Minimi Phase 3 UI Implementation Plan

## Gate

Milestone 2 provider verification passed with OpenRouter, but final live Tavily → OpenRouter → Supabase E2E acceptance remains pending because the current free OpenRouter route timed out during claim extraction. Do not start implementation until that E2E run passes or the provider/model timeout decision is explicitly accepted.

## Current UI baseline

- `src/app/chat/page.tsx` is an authenticated placeholder.
- The route already protects signed-out users and redirects them to `/login`.
- `POST /api/agent` is the existing server entry point for agent execution.
- Supabase persistence and historical retrieval are server-side and must remain behind the authenticated boundary.

## Phase 3 scope

Build the first usable Minimi chat experience without changing database schema or migrations:

1. Create a client chat surface at `/chat` with a message composer, submit state, and accessible message history.
2. Submit `{ query, conversationId? }` to `/api/agent` using same-origin requests.
3. Render status states: loading, completed, partial, failed, no-search, and needs-clarification.
4. Render answer text, citations, evidence limitations, and research metadata without exposing provider or database internals.
5. Preserve the returned `conversationId` and `snapshotId` for follow-up turns where available.
6. Add a new-conversation affordance and a safe empty state.
7. Support keyboard submission, visible focus states, responsive layout, and reduced-motion-friendly feedback.
8. Add client and route-level tests for success, validation errors, unauthenticated responses, provider failure, partial results, and clarification.

## Explicit non-goals

- No schema or migration changes.
- No direct browser access to Supabase tables for agent execution.
- No provider credentials in client code.
- No streaming, file uploads, tool configuration, multi-agent orchestration, or settings UI unless separately approved.

## Suggested implementation sequence

1. Extract the authenticated chat page into a server shell plus a small client component.
2. Add typed request/response helpers for `/api/agent`.
3. Implement optimistic local message rendering with rollback on request failure.
4. Render citations as safe external links with clear source labels.
5. Add compact status and limitation components.
6. Add tests and run lint, TypeScript, unit tests, and production build.
7. Manually verify the signed-out redirect and the complete signed-in flow.

## Ready-to-use Codex prompt

Implement Minimi Phase 3 only in `U:\minimi-agent`.

Replace the authenticated `/chat` placeholder with a polished, accessible chat interface backed by the existing `POST /api/agent` route. Keep all current uncommitted work. Do not change Supabase schema or migrations, commit, push, switch branches, expose credentials, or begin unrelated features.

Use a server-rendered authenticated shell and a focused client component for interactive state. Submit the existing request shape `{ query, conversationId? }`. Render user messages, assistant answer text, citations, evidence limitations, loading, partial, failed, no-search, and needs-clarification states. Preserve the returned conversation and snapshot identifiers for subsequent turns when present. Use same-origin fetches only; never call Supabase or OpenRouter from browser code.

Add accessible keyboard behavior, focus states, responsive layout, empty state, new-conversation control, safe error messages, and external citation links. Keep components small and business logic outside the page where practical. Add focused tests covering successful completion, partial response, clarification, 400 validation, 401 unauthenticated, and 503/provider failure. Read the repository instructions and relevant Next.js guidance before editing. Finish by running lint, `npx tsc --noEmit`, `npm test`, and `npm run build`, reporting exact results. Stop after Phase 3 UI changes; do not proceed to later phases.
