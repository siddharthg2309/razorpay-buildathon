# Revenue Recovery Agent

Razorpay Buildathon — Track 03. A payments-native recovery agent that turns
failed or at-risk revenue events into a controlled recovery loop, and reports
**measured** money recovered against a randomised holdout.

```
detects revenue at risk → diagnoses against the actual rail → chooses an
intervention its policy engine will authorise → executes through a token-gated
connector → verifies whether money arrived → recovers, escalates, or stops
```

The engine is real. The payment world it acts on is simulated, with one narrow
Razorpay Test Mode path proving the connector boundary is not. Because the world
is simulated we know the ground truth, so the attribution estimate can be
checked against it — which production data cannot do.

## Quick start

Requires Node 22 and a local Postgres.

```bash
npm install
npm run db:create && npm run db:migrate
npm run check                          # typecheck, lints, 242 tests
npm run batch scenarios/demo.yaml      # 2000 cases under a virtual clock
npm run console                        # http://localhost:4000
```

No credentials are needed for any of the above.

| Command | What it does |
|---|---|
| `npm run batch scenarios/demo.yaml` | Runs the cohort to terminal states, prints the attribution report |
| `npm run batch scenarios/demo.yaml -- --ablate` | Same seed with deliberation on and off |
| `npm run console` | Six screens: batch, cases, incidents, policy, attribution, metrics |
| `npm run tui` | The same event stream, in a shell |
| `npm run verify:replay` | Re-derives every stored revision and every Tier 0 decision |
| `npm run reset` | Returns the database to empty (~70ms) |
| `npm run preflight` | Checks Razorpay Test Mode credentials and the webhook secret |
| `npm run verify:ps` | Audits the build against the problem statement, with evidence per line |
| `npm run live-case` | Runs one case against real Razorpay Test Mode, end to end |
| `npm run verify:provider` | Confirms the configured backend works, without printing the key |
| `npm run demo` | One command: reset, console, batch, and what to show in order |
| `npm run lab:sweep` | Compares estimators against ground truth across seeds |
| `npm run test:mutation` | Breaks safety properties on purpose to check the suite notices |

## What is simulated and what is not

This boundary is the point, so it is stated rather than implied.

| | Real | Simulated |
|---|---|---|
| Case fabric, scheduler, state machine | ✅ | |
| Decline taxonomy, playbooks, policy engine | ✅ | |
| Capability tokens, admission, idempotency | ✅ | |
| Attribution and the holdout estimator | ✅ | |
| Anomaly detector and incident lifecycle | ✅ | |
| `createPaymentLink`, `fetchPaymentStatus`, webhook intake | ✅ Razorpay Test Mode | |
| Every other recovery action | | ✅ `SimulatedPSP` |
| Customer behaviour, declines, gateway degradation | | ✅ seeded, with hidden ground truth |

Every executed row in the console carries a **SIM** or **LIVE** badge. The
adapter declares its capabilities up front, so an unsupported action is refused
*before* execution rather than discovered during it.

Deliberately absent from the action library, each with a documented reason:
`charge_retry` (the provider owns the retry cycle on mandate rails),
`update_routing` (blast radius beyond one case, no verified capability),
`send_message` (DLT/TRAI and WhatsApp both require an approved template).

## The number

```
₹ 15.86 L        ₹ 8.43 L        ₹ 6.76 L        24.7%
GROSS            EST. INCREMENTAL TRUE (SIM)      ERROR
                 95% CI ₹ 6.08 L – ₹ 10.61 L
interval contains ground truth: YES

treated 1608 @ 35.0%   holdout 392 @ 17.6%   lift 17.3%
1 incident at gateway=A&issuer=HDFC · 192 parked · released 9/28/69/86
```

Gross is every rupee that arrived. Incremental is the money the agent *caused*,
measured against a 20% holdout that was never acted on. They are never conflated.

The residual error is not a pricing bug. It is chance imbalance between the arms
on an **unobservable** covariate — 19.9% of treated would have paid anyway
against 17.6% of holdout — and that ~2pp gap accounts for the whole overshoot.
Nothing observable corrects it, which is exactly what the interval is for. A
value-band-stratified estimator was implemented, measured, and made the point
estimate worse; the specified form is the headline and the stratified figure is
reported beside it.

**Claim the interval, not the point.**

## Verified against the problem statement

`npm run verify:ps` queries a completed batch and the shipped config, and reports
PASS / PARTIAL / GAP with the evidence behind each line. It is an audit, not a
checklist: anything that cannot be evidenced is reported as a gap.

```
PASS 69   PARTIAL 3   GAP 0
```

The three partials, stated rather than argued away:

- **Reroute to a backup path** is a simulated, approval-only proposal carrying a
  canary percentage and a TTL. Razorpay exposes no verified routing capability,
  so executing one would be a claim we cannot back.
- **Subscription retention** is reported as renewals collected on `/metrics`.
  `RECOVERED` requires matched money against the renewal obligation, so sending
  an email cannot satisfy it — but subscription lifecycle state is not modelled
  separately from the obligation.
- **Real execution** covers `createPaymentLink` and `fetchPaymentStatus` against
  Razorpay Test Mode. Every other action is simulated and labelled SIM.

## Architecture

Full detail in [`outputs/revenue-recovery-architecture-v2.md`](outputs/revenue-recovery-architecture-v2.md)
and [`outputs/build-plan.md`](outputs/build-plan.md).

```
L0 ingest      signature-verified webhooks, normalise, dedup
L1 detect      event triggers, timers, per-segment anomaly detector
L2 case fabric event reducer (sole writer of state), state machine, durable scheduler
L3 blackboard  evidence board, claim board, feature builders
L4 runtime     work router, Tier 0 classifier, parallel specialists, deliberation reducer
L5 govern      constrained optimizer, policy engine, capability minter, budget ledgers
L6 act         token-gated connectors — SimulatedPSP, RazorpayTestAdapter
L7 verify      outcome verifier, reconciler, attribution, append-only ledger
```

L7 writes an outcome event back to L2; the reducer produces a new revision and
only the specialists whose declared dependencies moved are rerun. That loop, not
a chain of prompts, is the product.

```
/packages/core        types, Clock, state machine, event reducer, taxonomy,
                      playbooks, roles, policy, capability tokens, stats
/packages/db          pool, migrations, ledger, case event store
/packages/engine      scheduler, leases, blackboard, work router, Tier 0, policy
                      engine, executor, reconciler, verifier, detector, incidents
/packages/connectors  PSPAdapter, SimulatedPSP, RazorpayTestAdapter, webhooks
/packages/agents      LLMProvider, OpenAI adapter, specialists, reducer, optimizer
/packages/attribution stratified holdout, estimator, bootstrap
/packages/sim         scenario, cohort, world model, batch runner, replay verifier
/packages/console     five screens + SSE stream
/packages/tui         terminal view
/actions              the action library — the closed set of things it can do
/taxonomy /playbooks /policies /scenarios
```

## Configuration

### The LLM provider

Paste the key straight into `.env` on the `OPENROUTER_API_KEY=` line — never
through a chat window, a commit, or a shell command, all of which keep history.
The file is gitignored and `chmod 600`.

```bash
npm run verify:provider      # shape, then the model catalogue, then one call
```

It reports a length, a prefix and a boolean — never the key. Provider errors are
redacted before printing, because they sometimes echo request context.

Two backends are supported behind one `LLMProvider` seam. OpenRouter speaks
Chat Completions and OpenAI speaks the Responses API, so they are separate
adapters rather than a base-url swap. OpenRouter wins when both keys are set: a
leftover OpenAI key should not silently override the backend you just chose.

Models are configuration, per role:

```
MODEL_DIAGNOSIS=openai/gpt-4o-mini
MODEL_CONTEXT=openai/gpt-4o-mini
MODEL_REDUCER=openai/gpt-4o-mini
```

Any model with structured-output support will do. One without it returns prose,
which fails schema validation here rather than reaching the claim board — so an
unstructured model cannot be used, by construction.

A provider is **optional**. Without it Tier 0 still carries ~95% of cases;
Tier 1 falls into degraded mode and escalates to a human rather than
manufacturing a generic action, and the ablation reports that it cannot measure
anything rather than printing a meaningless delta.

### Razorpay Test Mode

Needed only for the one live case.

1. Sign up or log in at **dashboard.razorpay.com**. Test Mode needs no KYC —
   only Live Mode does.
2. Switch the dashboard toggle to **Test Mode**. Everything below must be done
   with that toggle on, or you will generate live credentials.
3. **Settings → API Keys → Generate Test Key.** The Key ID looks like
   `rzp_test_XXXXXXXX`. The secret is shown **once** — copy it now.
4. **Settings → Webhooks → Add New Webhook.** You choose the secret yourself;
   put the same value in `RAZORPAY_WEBHOOK_SECRET`. Subscribe to
   `payment_link.paid`, `payment.failed`, `payment.captured`, and
   `payment.downtime.started` / `.resolved`.
5. The webhook URL must be publicly reachable, so for local development expose
   the console through a tunnel (`cloudflared tunnel --url http://localhost:4000`
   or `ngrok http 4000`) and point Razorpay at `https://<tunnel>/webhook`.

```bash
npm run preflight    # refuses a non-rzp_test_ key, creates a real link,
                     # and checks a forged signature is rejected
npm run live-case    # opens a case, mints a token, creates a REAL test-mode
                     # link, and polls until the money arrives
```

`live-case` prints an `rzp.io` URL. Open it and pay with a test instrument:

- **Netbanking** — pick any bank, then tap **Success** on the mock bank page.
  This is the reliable one: no card-network classification, settles immediately.
- **UPI** — VPA `success@razorpay`.
- **Cards** — needs a *domestic* Indian test card. Generic numbers like
  `4111 1111 1111 1111` are classified international and rejected, because
  international cards are disabled by default on test accounts. Current domestic
  numbers are at `razorpay.com/docs/payments/payments/test-card-details/`.

The case closes to `RECOVERED` on a verified capture. Then open
`http://localhost:4000/case/<id>` to read the trail: policy rule, capability
token, burned nonce, live attempt, settlement, terminal state.

Scripts load `.env` via Node's `--env-file-if-exists`, so no dotenv dependency.

The receiver lives at `POST /webhook` on the console. It verifies the signature
before parsing the body, deduplicates on the Razorpay entity id so a retried
delivery is a no-op, answers 401 rather than 400 on a bad signature so Razorpay
stops retrying a forged one, and acknowledges immediately rather than holding
the connection open while the engine works.

## Does the suite have teeth?

A green suite proves the tests pass, not that they would notice if the product
broke. `npm run test:mutation` breaks ten safety properties on purpose — quiet
hours stop blocking, tokens stop being burned, `RECOVERED` stops requiring
matched money — and reports any that survive. A survivor is not a failing test;
it is a property nobody is checking.

```
10/10 caught
```

## Invariants the tests enforce

| Invariant | Where |
|---|---|
| The virtual clock never rewinds; a 14-day sequence compresses to instants | `clock.test.ts` |
| Illegal case transitions throw; terminals are absorbing | `state-machine.test.ts` |
| The event reducer is pure — same log, same revision | `event-reducer.test.ts` |
| Replay reproduces every stored revision and every Tier 0 decision | `hardening.test.ts` |
| `seq` allocation survives 10 concurrent appends to one case | `db.test.ts` |
| A scheduled action fires exactly once, only after its virtual due time | `scheduler.test.ts` |
| Concurrent tick workers split the due set rather than double-leasing | `scheduler.test.ts` |
| A terminal transition cancels the rest of the dunning sequence atomically | `scheduler.test.ts` |
| A revoked mandate never yields a retry; pre-debit precedes debit | `tier0.test.ts` |
| Every taxonomy cause has a reachable playbook | `tier0.test.ts` |
| An inbound reply reruns only context and communication | `work-router.test.ts` |
| No role has a connector in its tool scope | `work-router.test.ts` |
| Quiet hours evaluate in the merchant timezone, wrapping midnight | `policy.test.ts` |
| A blocked action never spends contact budget | `policy.test.ts` |
| A replayed capability token is refused; concurrent double-spend has one winner | `policy.test.ts` |
| A crash mid-call reconciles against the PSP rather than re-issuing | `executor.test.ts` |
| An unsupported capability is refused before execution, token unburned | `executor.test.ts` |
| `RECOVERED` requires matched money, not a successful connector call | `verifier.test.ts` |
| A known decline code never reaches a provider | `agents.test.ts` |
| PII is stripped before any provider call | `agents.test.ts` |
| A provider outage escalates rather than inventing a plan | `agents.test.ts` |
| The optimizer cannot select an action outside the library | `agents.test.ts` |
| A mix shift that leaves every segment healthy does not fire | `incident.test.ts` |
| One issuer failing opens at the issuer, not the whole gateway | `incident.test.ts` |
| A case that terminates while parked is never released back to SCHEDULED | `incident.test.ts` |
| Natural recovery is excluded from **both** arms, so lift is not inflated | `attribution.test.ts` |
| `holdout_flag` cannot be changed once assigned (DB trigger) | `attribution.test.ts` |
| The same seed produces identical batch output | `sim.test.ts` |
| Every case in a batch reaches a terminal state | `sim.test.ts` |
| A forged webhook signature is rejected before the body is parsed | `hardening.test.ts` |
| Every executed row on the case trail carries SIM or LIVE | `console.test.ts` |
| A promise to pay is recorded as evidence and never as recovered money | `intent-checkout.test.ts` |
| A briefly paused checkout is not treated as abandoned | `intent-checkout.test.ts` |
| A session whose payment failed gets payment recovery, not cart messaging | `intent-checkout.test.ts` |
| No `now()` / `CURRENT_TIMESTAMP` / `Date.now()` outside `Clock` | `npm run lint:clock` |

## Notes on the build

Two deviations from the build plan, both deliberate:

- **npm workspaces, not pnpm.** Installing pnpm needs root on the build machine.
  Script names are unchanged.
- **A plain Node console, not Next.js + Tailwind.** No build step to fail on
  stage, `--reset` returns to a known state in under a second, and the charts
  were always going to be hand-rolled per the plan's own dependency-risk note.
  The §4a design tokens are implemented verbatim.
