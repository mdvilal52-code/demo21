# Phase Execution Protocol

This protocol is mandatory for every phase, every session, every change.
It is repository law. Nothing below may be skipped "to save time".

## Before changing code

1. Read `docs/PHASE-CONTRACTS.json` — find the phase that is `IN_PROGRESS` (or the next `PENDING` one).
2. Read the previous phase documentation in `docs/phases/`.
3. Inspect the current repository (structure, packages, migrations, tests).
4. Run the existing test suite and record the baseline.
5. Understand the existing architecture (`docs/MASTER-PLAN.md`, `docs/ARCHITECTURE.md` once it exists).
6. Never blindly overwrite working code.

## During implementation

- preserve backward compatibility
- use typed interfaces
- use schema validation (Zod) at every boundary
- use dependency injection
- use idempotency for every command / job / webhook
- use transactions for state changes
- use structured errors (`AppError` with stable error codes)
- use audit events for every mutation
- use least privilege (DB roles, tokens, tool permissions)
- never trust AI output
- never trust customer input
- never trust external API input
- never trust uploaded documents

## After implementation

```
IMPLEMENT
  → TEST
  → FAIL?
  → ROOT-CAUSE
  → FIX
  → TEST AGAIN
  → SECURITY TEST
  → REGRESSION
  → BUILD
  → REVIEW
```

## Quality gate pipeline (must be green, in this order)

```
IMPLEMENT
   ↓
TYPECHECK            pnpm typecheck
   ↓
LINT                 pnpm lint
   ↓
UNIT TEST            pnpm test:unit
   ↓
INTEGRATION TEST     pnpm test:integration   (Testcontainers: Postgres, Redis, MinIO)
   ↓
SECURITY TEST        pnpm test:security      (SAST, dependency scan, secret scan, authz tests)
   ↓
E2E TEST             pnpm test:e2e           (Playwright)
   ↓
BUILD                pnpm build
   ↓
CODE REVIEW          /code-review + checklist in docs/phases/PHASE-TEMPLATE.md
   ↓
ARCHITECTURE REVIEW  checklist against docs/MASTER-PLAN.md §1, §6
   ↓
REGRESSION TEST      full suite re-run on the final commit
   ↓
PASS?
 ↙     ↘
NO      YES
↓        ↓
FIX    FREEZE  (mark phase FROZEN in PHASE-CONTRACTS.json, write docs/phases/PHASE-NN.md)
↓        ↓
RETEST → NEXT PHASE
```

## Do not move to the next phase until

- all tests pass
- security checks pass
- build passes
- migrations pass (up, down, and re-up on a fresh database)
- no critical issue remains
- documentation is updated (`docs/phases/PHASE-NN.md`, `PHASE-CONTRACTS.json`, `ARCHITECTURE.md` if changed)

## Hard rules

- Do not create fake functionality merely to make tests pass.
- If a real external provider is required but credentials are unavailable:
  create a clean provider interface and integration boundary,
  but DO NOT fake successful production behavior.
  Use explicit `NOT_CONFIGURED` / `UNAVAILABLE` states, visible in the admin Settings page.
- Test doubles are allowed only inside test code, never wired into a production code path.
- Delete obsolete code only after confirming no active dependency.
- Never delete working functionality merely to simplify implementation.
- Never skip, disable, or quarantine a test to get green.

## Journey evaluation loop (applies once the workflow exists, Phase 3+)

After every phase that touches the customer journey:

```
01 Enquiry … 19 Post-Rental Follow-up
        ↓
EVALUATE ENTIRE JOURNEY  (correctness / security / UX)
        ↓
Detect problem?  → YES → FIX / TEST → loop
                 → NO  → RELEASE (freeze phase)
```
