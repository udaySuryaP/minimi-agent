<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Minimi Agent Instructions

## Project identity

Minimi is a general-purpose temporal-memory research agent. It answers questions by retrieving historical conversation context, resolving dates, and researching current information when appropriate. It is not a KTU-specific study assistant. Keep Minimi separate from ModuleWyse; never modify the ModuleWyse project or repository.

## Current architecture

Minimi is a modular monolith using the Next.js App Router, React, TypeScript, Tailwind CSS, Supabase PostgreSQL and authentication, Gemini for reasoning and generation, Tavily as its web-search tool, Zod for validation, and Vitest for tests. Phase 1 establishes the application, auth, database schema, RLS, and verification foundation. Gemini and Tavily orchestration and the complete chat experience are later-phase work; do not describe them as implemented until they exist in the code.

Use deterministic, inspectable orchestration. Do not add multi-agent frameworks, LangChain/LangGraph, Redis, or vector databases without a demonstrated requirement and explicit architectural approval.

## Core architectural principles

- Keep orchestration deterministic and inspectable.
- Distinguish event/valid time from recorded time.
- Resolve dates using the user's timezone.
- Retrieve historical conversation context before current web research when appropriate.
- Preserve finalized research snapshots and their captured claims and sources.
- Enforce explicit user ownership boundaries at the database level.
- Bound web-search calls and timeouts; handle failures explicitly.
- Ground answers in retrieved evidence and preserve prior research rather than silently overwriting it.

## Database and security

- Preserve the seven core tables and relationships: `profiles`, `conversations`, `messages`, `memory_items`, `research_snapshots`, `research_claims`, and `research_sources`.
- Maintain RLS on every user-owned table and preserve ownership triggers and composite ownership constraints.
- Never expose service-role credentials or API secrets in browser code, logs, or committed files. `NEXT_PUBLIC_*` variables are public.
- Use authenticated Supabase sessions and the established browser/server client boundaries.
- Never weaken RLS or snapshot immutability to make a test pass.
- Never apply remote or production migrations without the user's explicit approval.
- Treat `supabase/verification.sql` as a test harness, not proof of database correctness until it has been executed against a safe test database.

## Coding conventions

- Use strict TypeScript and validate external input with Zod where appropriate.
- Keep business logic separate from UI components; prefer small modules and clear names.
- Handle errors explicitly and avoid unnecessary abstractions and dependencies.
- Follow existing project conventions and do not add features unrelated to the active phase.
- Read the relevant Next.js guide in `node_modules/next/dist/docs/` before changing Next.js code; this installed version has breaking changes.

## Testing and validation

Run checks sequentially, especially on Windows:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Report actual outcomes. Unit tests do not replace database-level RLS and trigger verification.

## Git workflow

- Preserve all user changes. Review staged and unstaged diffs before committing.
- Never force-push, reset, clean, or discard work without explicit authorization.
- Never commit secrets, dependencies, build artifacts, or unrelated changes.
- Keep local and remote branch names aligned. Do not overwrite remote history; reconcile it with a non-destructive merge.

## Strict project boundaries

- Keep Minimi independent from ModuleWyse.
- Do not deploy or change remote infrastructure without explicit approval.
- Do not start a new phase without explicit instruction.
- Do not change architecture merely to satisfy an agent's framework preference.

## Current project status

Phase 1 has received independent source-review approval with limitations. The latest reported validation run passed lint, TypeScript, 50 unit tests, and the production build. The SQL verification script has been designed and statically inspected, but PostgreSQL runtime behavior, foreign-key cascade ordering, and authenticated RLS execution remain unverified until tested against a safe local or test PostgreSQL/Supabase instance. Phase 2 has not started.
