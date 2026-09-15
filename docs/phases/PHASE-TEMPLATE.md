# Phase NN — <name>

> Fill this in as the phase is executed. Copy to `docs/phases/PHASE-NN.md`.
> A phase is FROZEN only when every box below is checked and the doc is complete.

## 1. Pre-flight (Protocol §Before changing code)

- [ ] Read `docs/PHASE-CONTRACTS.json` — this phase is `IN_PROGRESS`
- [ ] Read the previous phase doc: `docs/phases/PHASE-(NN-1).md`
- [ ] Inspected repository (structure, packages, migrations, tests)
- [ ] Ran baseline test suite — result: ____
- [ ] Reviewed architecture (`MASTER-PLAN.md` §1, `ARCHITECTURE.md`)

## 2. Scope

Goal: <from PHASE-CONTRACTS.json>

Deliverables (from contract):
- [ ] ...

Out of scope for this phase:
- ...

## 3. Design / decisions

- ADRs added: `docs/adr/NNNN-*.md`
- Key decisions and why:
- Backward-compatibility notes:

## 4. Implementation notes

- New/changed packages:
- New endpoints / jobs / migrations:
- Boundaries validated with Zod:
- Idempotency / transactions / audit added where:
- Providers behind interfaces (+ `NOT_CONFIGURED` states):

## 5. Gate results (Protocol §Quality gate pipeline — all must be green)

| Gate | Command | Result | Notes |
|---|---|---|---|
| Typecheck | `pnpm typecheck` | ☐ | |
| Lint | `pnpm lint` | ☐ | |
| Unit | `pnpm test:unit` | ☐ | |
| Integration | `pnpm test:integration` | ☐ | |
| Security | `pnpm test:security` | ☐ | SAST / deps / secrets / authz |
| E2E | `pnpm test:e2e` | ☐ | |
| Build | `pnpm build` | ☐ | |
| Code review | `/code-review` | ☐ | findings addressed |
| Architecture review | checklist §1/§6 | ☐ | |
| Regression | `pnpm test` (final commit) | ☐ | |

Migrations verified: up ☐ / down ☐ / re-up on fresh DB ☐

## 6. Acceptance criteria (from contract) — demonstrated

- [ ] <criterion> — evidence: command output / screenshot path

## 7. Security checklist (this phase)

- [ ] No untrusted input reaches a sink without Zod validation
- [ ] No AI/customer/external/document input trusted implicitly
- [ ] Least-privilege respected (roles, tokens, tool permissions)
- [ ] Secrets not committed (gitleaks clean)
- [ ] New surfaces covered by authz tests

## 8. Docs updated

- [ ] `docs/phases/PHASE-NN.md` (this file) complete
- [ ] `docs/ARCHITECTURE.md` updated if architecture changed
- [ ] `docs/PHASE-CONTRACTS.json` → this phase `FROZEN`

## 9. Sign-off

- No fake functionality introduced
- No working functionality deleted without confirming no dependency
- Ready for next phase: ☐
