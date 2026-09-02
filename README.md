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
/packages/core     types, Clock, case state machine, event reducer, action library
/packages/db       pool, migration runner, ledger, case event store
/migrations        numbered SQL, applied in order
/actions           the action library
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
| No `now()` / `CURRENT_TIMESTAMP` / `Date.now()` outside `Clock` | `npm run lint:clock` |

## Status

Phase 0 (foundations) complete. Phase 1 (case fabric + durable scheduler) next.
