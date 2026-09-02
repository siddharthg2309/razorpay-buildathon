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

## Running the batch

```bash
npm run batch scenarios/demo.yaml            # 2000 cases under the virtual clock
npm run batch scenarios/demo.yaml -- --ablate  # deliberation on vs off
```

The provider is optional. Without `OPENAI_API_KEY` the engine still runs end to
end — Tier 0 carries ~95% of cases — but Tier 1 falls into degraded mode and
escalates, and the ablation says so rather than reporting a meaningless delta.

## Console

```bash
npm run console   # http://localhost:4000
npm run tui       # same event stream, in a shell
```

Five screens: batch run, cases and the per-case decision trail, incidents,
policy, attribution. No build step — the console is a plain Node HTTP server
rendering HTML, so `--reset` returns to a known state in seconds and there is no
bundler to fail on demo day. Charts are hand-rolled; the visuals here are simple
and a chart library is a dependency risk.

> The build plan specifies Next.js + Tailwind. Deviating for the reason above;
> the design tokens in §4a are implemented verbatim.

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
/packages/attribution  stratified holdout, incremental estimator, bootstrap
/packages/sim      scenario loader, cohort generator, world model, batch runner
/packages/console  five screens + SSE event stream, zero build step
/packages/tui      terminal view over the same event stream
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
| A gateway outage opens one incident, not one per child segment | `tests/incident.test.ts` |
| A mix shift that leaves every segment healthy does not fire | `tests/incident.test.ts` |
| Parked cases fire nothing, even after the clock advances past their due time | `tests/incident.test.ts` |
| A rate drop mid-ramp re-parks rather than pressing on | `tests/incident.test.ts` |
| Holdout assignment is deterministic and order-independent | `tests/attribution.test.ts` |
| `holdout_flag` cannot be changed once assigned (DB trigger) | `tests/attribution.test.ts` |
| Natural recovery is excluded from **both** arms, so lift is not inflated | `tests/attribution.test.ts` |
| The estimate's interval brackets simulator ground truth | `tests/attribution.test.ts` |
| Every taxonomy cause has a reachable playbook | `tests/tier0.test.ts` |
| Generated cases never carry a (rail, code) the taxonomy cannot classify | `tests/sim.test.ts` |
| The same seed produces identical batch output | `tests/sim.test.ts` |
| Every case in a batch reaches a terminal state | `tests/sim.test.ts` |
| A provider outage escalates rather than dropping the case | `tests/sim.test.ts` |
| One issuer failing opens at the issuer, not the whole gateway | `tests/incident.test.ts` |
| A case that terminates while parked is never released back to SCHEDULED | `tests/incident.test.ts` |
| The case trail shows rule, policy version, token and settlement | `tests/console.test.ts` |
| Every executed row on the trail carries a SIM or LIVE badge | `tests/console.test.ts` |
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
| 7 — Incident mode | done |
| 8 — Attribution estimator | done |
| 9 — Simulator + batch runner | done |
| 10 — Console UI | done |
| 11 — Demo hardening | next |

219 tests.

### Current batch output

```
₹ 15.86 L        ₹ 8.34 L        ₹ 6.79 L        22.9%
GROSS            EST. INCREMENTAL TRUE (SIM)      ERROR
                 95% CI ₹ 6.08 L – ₹ 10.61 L
interval contains ground truth: YES
treated 1608 @ 35.0%   holdout 392 @ 17.6%   lift 17.3%
1 incident opened at gateway=A&issuer=HDFC · 192 cases parked · released 9/28/69/86
```

The residual error is not a pricing bug. It is chance imbalance between the arms
on an **unobservable** covariate: 19.9% of treated would have paid anyway
against 17.6% of holdout, and that ~2pp gap accounts for the whole overshoot.
Nothing observable can correct it, which is exactly what the interval is for. A
value-band-stratified estimator was tried and made the point estimate worse, so
the simpler specified form is the headline and the stratified figure is reported
beside it as a diagnostic.
