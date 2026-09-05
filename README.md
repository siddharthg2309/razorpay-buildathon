# Revenue Recovery Agent

Razorpay Buildathon — Track 03. A payments-native agent that turns failed or
at-risk revenue events into a controlled recovery loop, and reports **measured**
money recovered against a randomised holdout.

```
detect revenue at risk → diagnose against the actual rail → choose an action the
policy engine will authorise → execute through a token-gated connector → verify
money arrived → recover, escalate, or stop
```

The engine is real. The payment world it acts on is simulated, with one narrow
Razorpay Test Mode path proving the connector boundary is not. Because the world
is simulated we know the ground truth, so the attribution estimate can be checked
against the true answer — which production data cannot do.

## Quick start

Requires Node 22 and a local Postgres. No credentials needed.

```bash
npm install
npm run db:create && npm run db:migrate
npm run check                       # typecheck, clock lint, 279 tests
npm run demo                        # reset, console, batch, and what to show
```

Or run the pieces: `npm run batch scenarios/demo.yaml` then `npm run console`
on http://localhost:4000.

## The number

```
₹14.89 L          ₹8.19 L            17.6%
COLLECTED         AGENT-CAUSED       LIFT OVER HOLDOUT
                  95% CI ₹6.32 – 10.29 L

treated 1588 @ 32.9%    holdout 412 @ 15.3%
1 incident at gateway=A · 776 cases parked · released 5/15/40/100%
```

Collected is every rupee that arrived. Agent-caused is the money the agent
*caused*, measured against a 20% holdout that was never contacted. The two are
never conflated.

`npm run batch` also prints the simulator's true incremental figure beside the
estimate and whether the interval contains it. The residual error is chance
imbalance between the arms on an **unobservable** covariate — who was going to
pay regardless. Nothing observable corrects it, which is what the interval is
for. **Claim the interval, not the point.**

## What is real and what is simulated

The boundary is the point, so it is stated rather than implied.

| | |
|---|---|
| **Real** | Case fabric, scheduler, state machine, event reducer · decline taxonomy, playbooks, policy engine · capability tokens, admission, idempotency · attribution and the holdout estimator · anomaly detector and incident lifecycle |
| **Real, against Razorpay Test Mode** | `createPaymentLink`, `fetchPaymentStatus`, webhook intake |
| **Simulated** | Every other recovery action (`SimulatedPSP`) · customer behaviour, declines and gateway degradation (seeded, with hidden ground truth) |

Every executed row in the console carries a **SIM** or **LIVE** badge, and the
adapter declares its capabilities up front, so an unsupported action is refused
*before* execution rather than discovered during it.

Three actions are deliberately absent from the library, each with a reason:
`charge_retry` (the provider owns the retry cycle on mandate rails),
`update_routing` (blast radius beyond one case, no verified capability),
`send_message` (DLT/TRAI and WhatsApp both require an approved template).

## Verified against the problem statement

`npm run verify:ps` queries a completed batch and the shipped config, then
reports PASS / PARTIAL / GAP with the evidence behind each line. Anything that
cannot be evidenced is reported as a gap.

```
PASS 69   PARTIAL 3   GAP 0
```

The three partials, stated rather than argued away:

- **Reroute to a backup path** stays a simulated, approval-only proposal.
  Razorpay exposes no verified routing capability, so executing one would be a
  claim we cannot back.
- **Subscription retention** is reported as renewals collected on `/metrics`;
  lifecycle state is not modelled separately from the obligation.
- **Real execution** covers two capabilities. Everything else is simulated and
  labelled SIM.

## Architecture

```
L0 ingest      signature-verified webhooks, normalise, dedup
L1 detect      event triggers, timers, per-segment anomaly detector
L2 case fabric event reducer (sole writer of state), state machine, scheduler
L3 blackboard  evidence board, claim board, feature builders
L4 runtime     work router, Tier 0 classifier, parallel specialists, reducer
L5 govern      constrained optimizer, policy engine, capability minter, budgets
L6 act         token-gated connectors — SimulatedPSP, RazorpayTestAdapter
L7 verify      outcome verifier, reconciler, attribution, append-only ledger
```

L7 writes an outcome event back to L2; the reducer produces a new revision, and
only the specialists whose declared dependencies moved are rerun. **That loop,
not a chain of prompts, is the product.**

```
packages/core         types, Clock, state machine, event reducer, taxonomy,
                      playbooks, roles, policy, capability tokens, stats
packages/db           pool, migrations, ledger, case event store
packages/engine       scheduler, leases, blackboard, work router, Tier 0, policy
                      engine, executor, reconciler, verifier, detector, incidents
packages/connectors   PSPAdapter, SimulatedPSP, RazorpayTestAdapter, webhooks
packages/agents       LLMProvider, OpenRouter and OpenAI adapters, specialists,
                      deliberation reducer, constrained optimizer
packages/attribution  stratified holdout, estimator, bootstrap intervals
packages/sim          scenario, cohort, world model, batch runner, replay
packages/console      eight screens + SSE stream        packages/tui  shell view
actions/              the closed set of things it can do
taxonomy/  playbooks/  policies/  scenarios/
```

## Commands

| Command | What it does |
|---|---|
| `npm run demo` | Reset, console, batch, and what to show in order |
| `npm run batch scenarios/demo.yaml` | 2000 cases under a virtual clock, then the attribution report |
| `npm run batch ... -- --ablate` | Same seed with deliberation on and off |
| `npm run console` | Eight screens on :4000 · `npm run tui` for the same stream in a shell |
| `npm run verify:ps` | Audits the build against the problem statement, evidence per line |
| `npm run verify:replay` | Re-derives every stored revision and every Tier 0 decision |
| `npm run test:mutation` | Breaks safety properties on purpose to check the suite notices |
| `npm run lab:sweep` | Compares estimators against ground truth across seeds |
| `npm run reset` | Returns the database to empty (~70ms) |
| `npm run preflight` · `live-case` · `settle-live` | The Razorpay Test Mode path |

## Does the suite have teeth?

A green suite proves the tests pass, not that they would notice if the product
broke. `npm run test:mutation` breaks ten safety properties on purpose — quiet
hours stop blocking, tokens stop being burned, `RECOVERED` stops requiring
matched money — and reports any that survive. A survivor is not a failing test;
it is a property nobody is checking.

```
10/10 caught
```

Among the invariants the 279 tests hold:

- A replayed capability token is refused; a concurrent double-spend has one winner
- A crash mid-call reconciles against the PSP rather than re-issuing
- `RECOVERED` requires matched money, not a successful connector call
- A revoked mandate never yields a retry; pre-debit precedes debit
- Quiet hours evaluate in the merchant timezone, wrapping midnight
- `holdout_flag` cannot be changed once assigned — enforced by a DB trigger
- Natural recovery is excluded from **both** arms, so lift is not inflated
- The optimizer cannot select an action outside the library
- PII is stripped before any provider call; a known decline code never reaches one
- No `now()` / `Date.now()` outside `Clock` — enforced by `npm run lint:clock`

## Configuration

### The LLM provider — optional

Put the key on the `OPENROUTER_API_KEY=` line in `.env`; the file is gitignored
and `chmod 600`. `npm run verify:provider` checks it end to end and reports a
length, a prefix and a boolean — never the key.

OpenRouter and OpenAI sit behind one `LLMProvider` seam (different APIs, so
separate adapters). Models are per-role config: `MODEL_DIAGNOSIS`,
`MODEL_CONTEXT`, `MODEL_REDUCER`. Any model with structured-output support will
do — one without it fails schema validation rather than reaching the claim
board, so an unstructured model cannot be used by construction.

Without a provider, Tier 0 still carries most cases and Tier 1 escalates to a
human rather than manufacturing an action.

### Razorpay Test Mode — only for the live case

1. **dashboard.razorpay.com**, toggle to **Test Mode** (no KYC needed).
2. **Settings → API Keys → Generate Test Key.** The secret is shown once.
3. **Settings → Webhooks.** You choose the secret; put it in
   `RAZORPAY_WEBHOOK_SECRET`. Subscribe to `payment_link.paid`,
   `payment.failed`, `payment.captured`, `payment.downtime.started` / `.resolved`.
4. Expose the console — `ngrok http 4000` — and point the webhook at
   `https://<tunnel>/webhook`.

```bash
npm run preflight    # refuses a non-test key, creates a real link,
                     # and checks a forged signature is rejected
npm run live-case    # opens a case, mints a token, creates a REAL test-mode
                     # link, and polls until the money arrives
npm run settle-live  # the same reconciliation by asking, when no tunnel is up
```

Pay with **netbanking → Success** (the reliable one) or UPI `success@razorpay`.
Generic card numbers are classified international and rejected; domestic test
cards are in the Razorpay docs. The case closes to `RECOVERED` on a verified
capture — then open `/case/<id>` to read the trail: policy rule, capability
token, burned nonce, live attempt, settlement, terminal state.

The receiver at `POST /webhook` verifies the signature before parsing the body,
deduplicates on the Razorpay entity id, answers 401 rather than 400 on a bad
signature so Razorpay stops retrying a forgery, and acknowledges immediately
rather than holding the connection while the engine works.

## Two deviations from the build plan

- **npm workspaces, not pnpm** — installing pnpm needs root on the build machine.
  Script names are unchanged.
- **A plain Node console, not Next.js + Tailwind** — no build step to fail on
  stage, and `reset` returns to a known state in under a second.
