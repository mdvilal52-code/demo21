# CLAUDE.md — Read this first, every session

This is a **production system** built phase by phase. Do not improvise outside the current phase.

## Start of every session / phase

1. Read `docs/PHASE-EXECUTION-PROTOCOL.md` — it is mandatory law.
2. Read `docs/PHASE-CONTRACTS.json` — find the phase that is `IN_PROGRESS` (or the next `PENDING`).
3. Read `docs/MASTER-PLAN.md` for architecture, journey and standards.
4. Read `docs/DESIGN-SYSTEM.md` before touching any UI (must match the emerald & copper reference).
5. Read the previous `docs/phases/PHASE-NN.md`.
6. Inspect the repo and run the existing tests before changing anything.

## Non-negotiables

- Do only the current phase. Ask the user before starting a new phase.
- Never fake functionality to pass tests. Missing credentials → explicit `NOT_CONFIGURED` / `UNAVAILABLE`, never a fake success.
- Never trust AI output, customer input, external API input or uploaded documents. Zod at every boundary.
- Idempotency, transactions, structured errors, audit events and least privilege on every mutation.
- Preserve backward compatibility; delete working code only after confirming no active dependency.
- A phase is done only when all ten gates are green and its phase doc is written:
  typecheck → lint → unit → integration → security → e2e → build → code review → architecture review → regression.

## Where things live

| Doc                                | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `docs/PHASE-EXECUTION-PROTOCOL.md` | mandatory rules before/during/after every change               |
| `docs/PHASE-CONTRACTS.json`        | machine-readable phase status, deliverables, acceptance        |
| `docs/MASTER-PLAN.md`              | architecture, repo layout, tech stack, 19-step journey, phases |
| `docs/DESIGN-SYSTEM.md`            | emerald & copper tokens, components, screen contracts          |
| `docs/phases/PHASE-TEMPLATE.md`    | copy to `PHASE-NN.md` when running a phase                     |
| `docs/design/reference/`           | reference images the UI must match                             |

## Workflow

Develop on the designated branch, commit with clear messages, keep the phase doc updated,
run the gate pipeline, and only mark a phase `FROZEN` in `PHASE-CONTRACTS.json` when it truly passes.
Do not create a pull request unless the user asks.
