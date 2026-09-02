# Revenue Recovery Agent

Track 03 — measured money recovered across a batch, with compliant escalation,
stopping rules, and an audit trail.

- **Architecture:** [`outputs/revenue-recovery-architecture-v2.md`](outputs/revenue-recovery-architecture-v2.md)
- **Build & demo plan:** [`outputs/build-plan.md`](outputs/build-plan.md)
- **Action library:** [`actions/library.yaml`](actions/library.yaml) — the closed set of
  things the system can decide to do. Frozen before Phase 0; every downstream
  phase compiles against these ids.

## Setup

Requires Node 22 and a local Postgres.

```bash
npm install
npm run db:create
npm run db:migrate
npm test
```

`npm run db:reset` drops and rebuilds from migrations.

> The build plan writes `pnpm`. This repo uses **npm workspaces** — installing
> pnpm globally needs root on this machine. Script names are unchanged
> (`npm test`, `npm run batch`).

## Layout

```
/packages/core     types, Clock, state machine, event reducer, taxonomy,
                   playbooks, roles, policy, capability tokens
/packages/db       pool, migration runner, ledger, case event store
/packages/engine   scheduler, leases, blackboard, work router, Tier 0,
                   policy engine, executor, reconciler, verifier
/packages/connectors  PSPAdapter, SimulatedPSP, RazorpayTestAdapter
/packages/agents   LLMProvider, OpenAI adapter, specialists, deliberation
                   reducer, constrained optimizer, agent runtime
/migrations        numbered SQL, applied in order
/actions           the action library
/taxonomy          decline codes per rail
/playbooks         (domain, cause) -> default plan
/policies          versioned merchant policy
/scripts           lint-clock.ts — fails on wall-clock reads outside Clock
/tests             vitest
```

## Invariants the tests enforce

| Invariant | Where |
|---|---|
| The virtual clock never rewinds, and a 14-day sequence compresses to instants | `tests/clock.test.ts` |
| Illegal case transitions throw; terminals are absorbing; incident suppression is not terminal | `tests/state-machine.test.ts` |
| The event reducer is pure — same log, same revision | `tests/event-reducer.test.ts` |
| Replay from `case_events` reproduces the stored revision exactly | `tests/db.test.ts` |
| `seq` allocation survives 10 concurrent appends to one case | `tests/db.test.ts` |
| A rejected event leaves no trace — the whole append rolls back | `tests/db.test.ts` |
| Forbidden actions (`charge_retry`, `update_routing`, `send_message`) fail at load with a reason | `tests/action-library.test.ts` |
| Only `create_payment_link` and `fetch_payment_status` are marked live | `tests/action-library.test.ts` |
| A scheduled action fires exactly once, only after its virtual due time | `tests/scheduler.test.ts` |
| Concurrent tick workers split the due set rather than double-leasing | `tests/scheduler.test.ts` |
| A terminal transition cancels the rest of the dunning sequence atomically | `tests/scheduler.test.ts` |
| A revoked mandate never yields a retry; pre-debit is ordered before debit | `tests/tier0.test.ts` |
| An inbound reply reruns only context and communication | `tests/work-router.test.ts` |
| No role has a connector in its tool scope | `tests/work-router.test.ts` |
| Quiet hours are evaluated in the merchant timezone, wrapping midnight | `tests/policy.test.ts` |
| A blocked action never spends contact budget | `tests/policy.test.ts` |
| A replayed capability token is refused; concurrent double-spend has one winner | `tests/policy.test.ts` |
| A crash mid-call reconciles against the PSP rather than re-issuing | `tests/executor.test.ts` |
| An unsupported capability is refused before execution, token unburned | `tests/executor.test.ts` |
| RECOVERED requires matched money, not a successful connector call | `tests/verifier.test.ts` |
| A known decline code never reaches a provider | `tests/agents.test.ts` |
| PII is stripped before any provider call | `tests/agents.test.ts` |
| A role whose contract forbids a provider never receives one | `tests/agents.test.ts` |
| One failing specialist does not discard the others' claims | `tests/agents.test.ts` |
| The reducer spends a provider call only on a material conflict | `tests/agents.test.ts` |
| A provider outage escalates rather than inventing a plan | `tests/agents.test.ts` |
| The optimizer cannot select an action outside the library | `tests/agents.test.ts` |
| No `now()` / `CURRENT_TIMESTAMP` / `Date.now()` outside `Clock` | `npm run lint:clock` |

## Status

| Phase | State |
|---|---|
| 0 — Foundations | done |
| 1 — Case fabric + scheduler | done |
| 2 — Blackboard, Tier 0, work router | done |
| 3 — Policy engine + capability tokens | done |
| 4 — Connectors + executor | done |
| 5 — Verifier + reconciler | done |
| 6 — Agent runtime + provider adapter | done |
| 7 — Incident mode | next |
| 8–11 | pending |

151 tests.
