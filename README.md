# AI Concierge — Luxury Car Rental (Dubai)

An AI concierge for a luxury car-rental business. Customers reach out over WhatsApp, Web and Email;
an AI orchestrator drives a 19-step rental journey (enquiry → quote → documents → payment →
delivery → return → invoice → follow-up) with human escalation, zero-trust security, an admin
dashboard and a customer mobile app.

> **Status: in progress.** Journey Steps 1-4 (Enquiry/Intent, Extract Dates & Location, Determine
> Vehicle, Ask Missing Information) are `FROZEN`; a WhatsApp channel + automated Step 1-4 pipeline
> is `IN_PROGRESS` (see `docs/PHASE-5.md`). See `docs/PHASE-CONTRACTS.json` for authoritative
> per-phase status. Implementation happens **one phase at a time**, on request, following
> `docs/PHASE-EXECUTION-PROTOCOL.md`.

## Read first

| Document                                                                 | Purpose                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [`CLAUDE.md`](./CLAUDE.md)                                               | What to read at the start of every session                            |
| [`docs/MASTER-PLAN.md`](./docs/MASTER-PLAN.md)                           | Architecture, repo layout, tech stack, 19-step journey, all 10 phases |
| [`docs/PHASE-CONTRACTS.json`](./docs/PHASE-CONTRACTS.json)               | Machine-readable phase status, deliverables, acceptance criteria      |
| [`docs/PHASE-EXECUTION-PROTOCOL.md`](./docs/PHASE-EXECUTION-PROTOCOL.md) | Mandatory rules and quality-gate pipeline for every change            |
| [`docs/DESIGN-SYSTEM.md`](./docs/DESIGN-SYSTEM.md)                       | Emerald & copper design tokens, components and screen contracts       |

## Phases

1. Foundation & Platform Skeleton
2. Core Domain & Data Model
3. Event / Workflow Engine
4. AI Orchestrator & Provider Abstraction
5. Channels, Documents, Payments, CRM & Fulfilment
6. Security Engine & Zero Trust
7. Admin Dashboard (Web)
8. Customer Mobile App (PWA)
9. Observability, AI Evaluation & Automatic QA
10. Infrastructure, CI/CD & Release

Each phase must pass all ten gates before it is frozen:
typecheck → lint → unit → integration → security → e2e → build → code review → architecture review → regression.

## Tech stack (locked)

Next.js · TypeScript · Tailwind · shadcn/ui · Fastify · PostgreSQL/Prisma · Redis/BullMQ ·
S3-compatible storage · provider-agnostic AI (Anthropic/OpenAI/…) · OIDC/OAuth2 · OpenTelemetry ·
Vitest/Playwright/Testcontainers · Docker/Terraform · GitHub Actions with mandatory gates.
