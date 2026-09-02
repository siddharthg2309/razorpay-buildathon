# Revenue Recovery Agent — Build & Demo Plan

**Companion to:** `revenue-recovery-architecture-v2.md`
**Scope:** everything from empty repo to a demo that shows a rupee figure a judge can trust.

---

## 0. The two facts that shape this plan

1. **The bar is "measured money recovered across a batch."** So the build is not done when one case works end to end. It is done when a batch of a few hundred cases runs, a holdout splits, and a number comes out with a denominator.

2. **We are not integrating with live production anything.** Real declines do not arrive on demand, a 14-day dunning sequence does not fit in a demo slot, and there is no live merchant traffic to detect an incident in. The simulator is therefore a **first-class deliverable**, while one narrow Razorpay Test Mode flow proves that the connector and webhook boundary are real.

The honest framing on stage, said plainly and early: *"The engine is real. The payment world it acts on is simulated, with one live Razorpay test-mode case to show the connector is real. Because the world is simulated, we know the ground truth — which means we can show you that our estimate's confidence interval actually contains the true value. You can't do that with production data."*

That turns the biggest apparent weakness into the strongest claim in the room.

---

## 1. Stack and repo layout

**TypeScript monorepo.** One language across engine, simulator, and UI means less context-switching at hackathon pace, and the type definitions for cases/actions/events are shared rather than duplicated.

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript |
| DB | Postgres (`FOR UPDATE SKIP LOCKED` is the scheduler primitive; JSONB for blackboard claims, evidence, and ledger) |
| Migrations | drizzle or plain SQL files — no ORM ceremony |
| Queue | in-process worker loop over the `scheduled_actions` table; no external broker |
| Agent runtime | Case blackboard, work router, parallel role workers, deliberation reducer, constrained optimizer |
| LLM | `LLMProvider` interface; `OpenAIResponsesProvider` uses the OpenAI Node SDK + Responses API. Models are configured per specialist role |
| Web console | Next.js + Tailwind, server components where possible |
| Terminal view | plain Node + `chalk`, reading the same event stream over SSE |
| Charts | hand-rolled SVG — no chart lib, the visuals here are simple and a library is a dependency risk |

```
/packages
  /core          types, event reducer, case state machine, policy engine, taxonomy
  /agents        role contracts, work router, claim reducer, optimizer, LLMProvider
  /engine        L0–L7 workers: ingest, detect, blackboard, govern, act, verify
  /connectors    PSPAdapter interface + SimulatedPSP + RazorpayTestAdapter
  /sim           event simulator, virtual clock, scenarios, ground truth
  /attribution   holdout assignment, estimator, batch runner
  /console       Next.js web UI
  /tui           terminal stream view
/scenarios       *.yaml — demo cohorts
/policies        *.yaml — versioned merchant policy
```

---

## 2. Phase plan

Hours assume a small team working in parallel. **P1 = must exist for the demo. P2 = strongly wanted. P3 = cut first.**

### Phase 0 — Foundations (3h, P1)

- Monorepo, TS config, Postgres up, migration runner.
- **`Clock` interface** implemented on day one — `RealClock` and `VirtualClock`. Every single component takes a clock. Retrofitting this later is the most expensive mistake available.
- Shared types: `Case`, `CaseEvent`, `CaseRevision`, `Evidence`, `Claim`, `AgentRun`, `Action`, `Plan`, `LedgerEntry`.
- Deterministic event reducer: `(previousRevision, CaseEvent) → CaseRevision`; it is the sole writer of case state.
- Append-only `case_events` and `ledger` writers. The event log is the replay input; the ledger is the decision/side-effect audit. `seq` is allocated inside the case-row lock.
- **`/actions/library.yaml` frozen before any other phase starts.** Every downstream phase compiles against these action IDs: playbooks (Phase 2), per-rail permissions (Phase 3), and the optimizer's candidate set (Phase 6).
- Lint rule in CI: no `now()` or `CURRENT_TIMESTAMP` in migrations or queries. Every time value comes from the injected `Clock`, or the virtual clock silently stops governing that path.

**Done when:** `pnpm test` runs, an event reduces to a reproducible case revision, the ledger can be written and read back, and the virtual clock can be advanced.

### Phase 1 — Case fabric + scheduler (6h, P1)

- `obligations`, `cases`, `case_events`, and `case_revisions` tables; case state machine with explicit legal transitions (reject illegal ones loudly).
- Obligation dedup on `(merchant, external_ref)`; obligation lease table.
- **Durable scheduler**: `scheduled_actions`, leased tick worker, cancel-on-terminal in the same transaction.

**Done when:** you can schedule an action 3 virtual days out, advance the clock, and watch it fire exactly once — and cancelling the case cancels it.

*This phase is the spine. If it is shaky, everything downstream is.*

### Phase 2 — Blackboard, Tier 0, and work routing (6h, P1)

- Case blackboard: typed, append-only evidence plus versioned, expiring claims. Each row carries source, observation time, and case revision.
- **Decline taxonomy for India rails** — cards, UPI AutoPay, e-NACH, netbanking, wallets. Hard vs soft, retry eligibility, per-code ceiling.
- Deterministic classifier: `(rail, code, context) → cause, confidence, rule_id`.
- Playbook table: `(domain, cause) → default plan`.
- Role registry with `dependsOn: EvidenceKind[]` per role. The work router derives the rerun set from it — `(changed evidence kinds, case state) → roles to rerun` — and invalidates only the claims whose declared dependencies moved, instead of rerunning every agent.

**Done when:** a simulated `payment_failed` with `INSUFFICIENT_FUNDS` on UPI AutoPay produces a cause, confidence, rule ID, and plan—with zero model calls—and an inbound reply invalidates only context/communication claims.

### Phase 3 — Policy engine + capability tokens (5h, P1)

- Policy as versioned YAML per merchant: retry caps, contact caps, quiet hours, amount thresholds requiring approval, allowed actions per rail.
- Rules engine evaluating a plan → `allow | block | require_approval` + reason + rule ID.
- **Capability token minter** (HMAC) and `token_burns` table with unique index.
- **Budget ledgers**: contact budget with atomic decrement, retry counter, spend counter.

**Done when:** an over-cap contact attempt is blocked with a named rule, and replaying a burned token is rejected.

### Phase 4 — Connectors + executor (5h, P1)

- Capability-specific adapter interface: `createPaymentLink`, `resumeCheckout`, `requestPaymentMethodUpdate`, `fetchPaymentStatus`, `sendApprovedTemplate`, `createOpsEscalation`.
- **`SimulatedPSP`** — see §3.
- **`RazorpayTestAdapter`** — signed webhooks plus only the supported Payment Link or test Subscription flows used in the live proof. No generic one-time `chargeRetry` or unverified routing override.
- Idempotent executor: write `action_attempts` row **before** the call, reconcile `in_flight` rows on boot.
- Connector admission check rejecting any call without a valid unburned token.
- Executor acquires the obligation lease at **admission**, not at fan-out, revalidates the plan against the current case revision, then presents the token.

**Done when:** the engine executes any adapter-supported plan without adapter-specific business logic, rejects an unsupported capability before execution, and a killed process mid-call reconciles rather than double-charging.

### Phase 5 — Verifier + reconciler (3h, P1)

- Outcome verifier: consumes settlement/status events, decides the next case state.
- Reconciler: match money received to the obligation. For B2B, Smart Collect virtual account matching.
- Terminal-state writer that cancels pending scheduled actions atomically.

**Done when:** a verified collection or provider-confirmed retry moves the case to `RECOVERED` and the remaining scheduled actions vanish from the schedule.

### Phase 6 — Agent runtime + OpenAI provider adapter (7h, P1)

Implement the §4 runtime. `OpenAIResponsesProvider` is one implementation of `LLMProvider`, not the orchestration layer.

- Role registry with evidence scope, permitted retrieval tools, JSON claim schema, timeout, call budget, and cache key per role.
- Run independent roles concurrently with `Promise.allSettled`; persist every run and claim against one `case_revision` before the reducer sees them.
- P1 specialists: payment diagnosis, customer/context, incident intelligence, recovery economics, communication, and deliberation reducer. The recovery-economics role is deterministic in P1.
- Reducer: deterministic precedence/conflict rules first; invoke the provider only for material unresolved conflict. It must return a strategy and rejected alternatives, never an executable connector call.
- Constrained optimizer: rank permitted action-library candidates by expected incremental value, cost, model spend, and risk penalty.
- The OpenAI adapter uses `openai.responses.create()` with `text.format` JSON Schema. Give it bounded redacted evidence, stable instructions first, and a `prompt_cache_key` per specialist role.
- Injection posture: reply interpretation returns enum + fields only, no tool access. Communication fills approved template slots only.
- Store provider/model, schema version, latency, usage, validation result, reducer trace, and optimizer scores in the ledger.
- **Degraded-mode fallback** only to an explicit, policy-allowed Tier 0 playbook; otherwise escalate or stop safely.

**Done when:** an ambiguous failure fans out to the required specialists; they persist cited claims for the same case revision; the reducer records why it accepted or rejected conflicting claims; the optimizer ranks known actions; and OpenAI cache telemetry is visible on a repeated agent run.

### Phase 7 — Incident mode (6h, P1 core + P2 hardening)

- **P1:** ingest a Razorpay downtime signal or seeded approval-rate anomaly, open one incident, attach/suppress affected cases, and stage their release after recovery.
- **P2:** seasonal per-segment baselines, volume floor, z-test, dwell, BH correction, child suppression and auto-close.
- Incident graph, case attachment, `suppressed_by_incident`.
- **Release controller**: ramp + jitter + circuit breaker in the simulator.
- A routing change remains a simulated, approval-only proposal until a supported external capability is verified.

**Done when:** injecting a gateway degradation opens exactly one incident (not forty), parks the affected cases, and staged release resumes them without re-triggering the detector.

*This is the differentiator. Protect its time.*

### Phase 8 — Attribution + batch runner (4h, P1)

- Holdout assignment at case creation: stratified by cause and value band, written immutably.
- Estimator per architecture §10, with per-domain measurement windows, exclusion rules, a 95% confidence interval and a bootstrap interval for incremental rupees.
- Agent-runtime ablation runner: same seed with parallel specialist claims enabled versus Tier 0 fallback; report provider spend and model-call rate separately.
- **Batch runner**: load a scenario, create N cases, run to completion under the virtual clock, emit the attribution report.

**Done when:** `pnpm batch scenarios/demo.yaml` prints gross recovered, incremental recovered, holdout rate, treated rate, and cost per rupee.

### Phase 9 — Simulator + ground truth (5h, P1)

See §3 in full. Deliverables: latent customer model, outcome model, scenario loader, checkout-event fixture, event injector, seeded RNG and ground-truth reporter.

**Done when:** the same seed produces byte-identical batch output twice, and the ground-truth reporter prints the true incremental recovery next to the estimated one.

### Phase 10 — UI (8h, P1)

See §4. Web console (5 screens) + terminal stream view.

**Done when:** a judge can click one case and read its complete decision trail without you narrating it.

### Phase 11 — Demo hardening (4h, P1)

- Seed lock, dry runs, a `--reset` that returns to a known state in under 5 seconds.
- Ledger replay verifier: replay reproduces every Tier 0 decision.
- The one live Razorpay test-mode case, pre-flighted.
- Fallback recording of the full run in case the venue wifi dies.
- Public-repo handoff: root README with architecture, one-command demo instructions, synthetic-versus-live boundary and Test Mode/webhook setup notes.

### Cut ladder

If time runs out, cut in this order: advanced incident statistics/reroute → extra checkout and invoice variants → terminal view. **Never cut:** scheduler, capability tokens, attribution, batch runner, simulator, or the basic incident-suppression path. Those are the demo.

---

## 3. Demo strategy — how to show this without live integrations

### 3a. The adapter seam

Everything the engine does to the outside world goes through `PSPAdapter`. Two implementations, chosen by config. **The engine cannot tell them apart** — that is the point, and it is a claim you can make on stage while showing the interface file.

```ts
interface PSPAdapter {
  createPaymentLink(req: LinkRequest, token: CapabilityToken): Promise<Link>
  resumeCheckout(req: CheckoutRequest, token: CapabilityToken): Promise<CheckoutSession>
  requestPaymentMethodUpdate(req: UpdateRequest, token: CapabilityToken): Promise<RecoveryLink>
  sendApprovedTemplate(req: MessageRequest, token: CapabilityToken): Promise<Delivery>
  createOpsEscalation(req: EscalationRequest, token: CapabilityToken): Promise<Escalation>
  fetchPaymentStatus(idemKey: string): Promise<PaymentResult | null>
}
```

### 3b. The virtual clock

Every scheduled action fires against `clock.now()`. In demo mode the clock is advanced in jumps by the batch runner: a 14-day dunning sequence with retries at T+1, T+3, T+7 completes in about 90 seconds of wall time, with every intermediate state written to the ledger exactly as it would be in production.

This is the single mechanic that makes the demo possible. Without it there is no way to show a completed recovery loop in a five-minute slot.

### 3c. The simulated PSP has hidden ground truth

This is what elevates the simulation from a mock to an asset. Each simulated customer carries **latent state the engine never sees**:

```yaml
customer:
  has_funds_after: T+2d        # NSF clears on payday
  card_expired: false
  mandate_state: active
  responds_to_link: 0.35       # probability
  will_pay_regardless: false   # ← the natural-recovery flag
  preferred_language: hinglish
```

`will_pay_regardless` is the important one. It marks the customers who would have paid with no intervention at all — the natural recovery rate. Because the simulator knows exactly who they are, it can compute the **true** incremental recovery. The attribution service, which sees only the holdout, computes an **estimate**.

Putting those two numbers side by side on the final screen is the strongest thing in the demo:

```
  True incremental (simulator ground truth)   ₹ 2,14,300
  Estimated (holdout attribution)             ₹ 2,08,900
  Error                                            2.5%
```

No team using production data can show that line. It says: our measurement method is validated, not just asserted.

### 3d. Scenario files

```yaml
# scenarios/demo.yaml
seed: 20260902
merchant: acme-subscriptions
cohort:
  size: 2000
  domains:
    subscription_renewal: 0.55
    payment_failure: 0.30
    checkout_abandonment: 0.10
    overdue_invoice: 0.05
  rails:
    card: 0.45
    upi_autopay: 0.35
    enach: 0.15
    netbanking: 0.05
  causes:
    insufficient_funds: 0.34
    expired_card: 0.14
    mandate_revoked: 0.09
    otp_failure: 0.12
    gateway_timeout: 0.16
    issuer_decline: 0.10
    unmapped_code: 0.05        # ← forces Tier 1
  value_distribution: lognormal(mu=7.6, sigma=0.9)
holdout: 0.20
injections:
  - at: T+2h
    type: gateway_degradation
    segment: { gateway: A, issuer: HDFC, method: card }
    approval_drop: 0.55
    duration: 40m
```

The `unmapped_code` slice exists purely so Tier 1 fires during the demo and you can point at a case where parallel specialist claims changed the plan. The synthetic batch is not presented as live merchant traffic; its hidden ground truth validates the holdout estimator.

### 3e. Determinism and replay

- One seed drives customer generation, outcome sampling, and injection timing. Same seed, same run, every time — so you can rehearse the demo and so a judge can ask you to run it again.
- Provider-backed agent calls are the only non-deterministic element. Cache their structured claims by role and input hash so a replay is fully reproducible; the cache is transparent and shown in the UI.
- **Replay verifier**: re-run `case_events` through the event reducer; assert every Tier 0 decision reproduces and every Tier 1 run reproduces its stored claims, reducer trace, and optimizer inputs. This is how you *prove* the audit trail rather than just displaying a table of it.

### 3f. The one real thing

Run a single case against `RazorpayTestAdapter` live: create a real test-mode payment link or test Subscription action, show the real payment ID, then let a verified webhook close the case. One case, thirty seconds. It converts "simulated" from a category to a scope: *the recovery engine is real, the batch payment world is simulated.*

### 3g. Synthetic scenario gallery

The batch must include different recovery paths, not 2000 cosmetic copies of one decline. Each scenario has a hidden outcome model, visible evidence, an allowed action set and an expected terminal state.

| Scenario | Trigger and visible evidence | Recovery path | What it proves |
|---|---|---|---|
| **Subscription: insufficient funds** | `subscription.pending`, active mandate, funds clear at T+2d | Observe provider retry; if policy allows, send an approved update/reminder template | Time-aware recovery, no blind charge retry |
| **Subscription: mandate revoked** | Failed renewal, revoked mandate | Stop debit attempts; request payment-method update or escalate | A stopping rule protects the customer |
| **Payment: gateway timeout** | `payment.failed`, timeout evidence, affected segment | Offer a supported Payment Link/alternate checkout in simulation; attach to an incident when relevant | Cause-aware intervention |
| **Checkout abandonment** | Local checkout fixture records last stage, no completion after virtual inactivity | Preserve cart and create a return-to-checkout path | First-party funnel event, not a fake PSP webhook |
| **B2B invoice: missing PO** | Invoice overdue; reply interpreter extracts `MISSING_PO` | Pause collection, request PO through approved template, then resume | Collections without aggressive automation |
| **Ambiguous/unmapped failure** | Conflicting evidence or an unknown code | Parallel specialist claims → reducer → optimizer proposes only known action IDs | Meaningful bounded multi-agent deliberation |
| **Gateway incident** | Seeded approval-rate fall or Razorpay downtime event across a segment | Open incident, suppress child actions, propose supported/simulated remediation, staged release | Event-driven plus incident-driven coordination |
| **Policy block** | Quiet hours, contact budget exhausted, dispute, or opt-out | Block action and emit a rule-backed terminal/audit event | Bounded execution and auditability |

---

## 4. UI design

The brief you gave: **clean, classic, monospace, boxed.** That reads as an instrument panel — a payments operations console, not a marketing page. It is also the right aesthetic for the content: dense numbers, state machines, audit trails. And it is fast to build, which matters.

### 4a. Design tokens

```css
:root {
  /* light */
  --bg:        #FAF9F6;   /* warm paper */
  --panel:     #FFFFFF;
  --ink:       #14120F;
  --ink-2:     #55504A;
  --ink-3:     #8A847C;
  --rule:      #DDD8D0;   /* 1px borders, everywhere */
  --accent:    #B8862F;   /* single accent — amber/brass */
  --ok:        #2E6F4E;
  --warn:      #A8641B;
  --err:       #9B2C2C;
  --held:      #4A5B8C;   /* suppressed / parked */
}
:root:not([data-theme="light"]) { /* dark, via prefers-color-scheme */
  --bg:     #0F0E0C;
  --panel:  #17150F;
  --ink:    #F2EDE3;
  --ink-2:  #A9A196;
  --ink-3:  #6E675E;
  --rule:   #2A2620;
  --accent: #D8A64A;
}
```

**Rules:** every executed row — in the case inspector and in the terminal stream — carries a `SIM` or `LIVE` badge. Screen 2 exists to prove the honesty claim, and it currently shows `retry_within_cap`, which `RazorpayTestAdapter` deliberately cannot perform; unlabelled, that screen contradicts the boundary it is meant to demonstrate. IBM Plex Mono or JetBrains Mono throughout. 1px solid borders, no shadows, no gradients, no rounded corners beyond 2px. Numbers tabular-aligned. One accent colour only — it marks the thing you want looked at, and nothing else. State colours are used only on state.

This also happens to echo the dark/brass palette of the Track 03 card itself, which reads as deliberate.

### 4b. Screens

**Screen 1 — Batch Run (the money screen)**

```
┌─ RUN acme-subscriptions ─ seed 20260902 ─ T+14d ────── COMPLETE ─┐
│                                                                  │
│   ₹ 8,42,000        ₹ 2,08,900        ₹ 2,14,300         2.5%   │
│   AT RISK           EST. INCREMENTAL  TRUE (SIM)         ERROR   │
│                     95% CI: 1.65–2.53L GROUND TRUTH              │
│                                                                  │
│   gross recovered  ₹ 3,11,400   ·   treated 320   holdout 80    │
│   treated rate       41.2%      ·   holdout rate      17.4%     │
│   cost / ₹ recovered  ₹0.031    ·   model spend    ₹ 412        │
├──────────────────────────────────────────────────────────────────┤
│  TIER      cases    resolved    │  TERMINAL STATE       cases     │
│  ── T0       322        265     │  RECOVERED              165     │
│  ── T1        62         51     │  UNRECOVERABLE          122     │
│  ── T2        16          8     │  STOPPED (rule)          90     │
│                                 │  DISPUTED / OPTED OUT    23     │
├──────────────────────────────────────────────────────────────────┤
│  approval rate ▁▂▃▅▆▆▆▂▁▁▂▅▆▆▇▇   ← incident window shaded       │
└──────────────────────────────────────────────────────────────────┘
```

**Screen 2 — Case Inspector (the trust screen)**

The decision trail for one case, top to bottom, nothing hidden. This is the screen that wins the audit-trail requirement, because a judge reads it themselves instead of being told about it.

```
┌─ CASE c_8812 ─ obligation ob_4471 ─ ₹ 4,200 ─ RECOVERED ─────────┐
│  rail UPI_AUTOPAY   customer cu_339   holdout: NO   tier: T1     │
├──────────────────────────────────────────────────────────────────┤
│ T+0h00  DETECTED      subscription.charge_failed                 │
│                       code MANDATE_AMOUNT_EXCEEDED               │
│ T+0h00  EVIDENCE      mandate cap ₹3,000 · attempt ₹4,200        │
│                       mandate active · 2 prior successes         │
│ T+0h01  FAN-OUT       diagnosis · context · economics            │
│                       ↳ diagnosis: mandate_cap_breach 0.88       │
│                         cites ev_1102, ev_1104                   │
│                       ↳ economics: 3 eligible actions scored     │
│ T+0h01  REDUCE        diagnosis accepted; no incident conflict   │
│ T+0h01  OPTIMIZE      1. notify_mandate_update  (link)           │
│                       2. wait 48h                                │
│                       3. retry_within_cap ₹3,000                 │
│                       stop: paid | opt-out | attempt 3           │
│ T+0h01  POLICY        ALLOW  rule R-114 (upi.cap_breach)         │
│                       policy v7 · token tk_9d3 · cap ₹3,000      │
│ T+0h01  EXECUTE       whatsapp template WA_MANDATE_UPD (hi)      │
│                       budget 1/2 in 7d · quiet hours OK          │
│ T+2h14  OBSERVE       inbound reply → context claim              │
│                       intent: WILL_UPDATE   ← treated as data    │
│ T+2d01  EXECUTE       pre-debit notification  (RBI, T-24h)       │
│ T+3d01  EXECUTE       retry ₹3,000  idem 7c2f…  token tk_a41     │
│ T+3d01  VERIFY        captured ₹3,000 · reconciled to ob_4471    │
│ T+3d01  TERMINAL      RECOVERED                                  │
└──────────────────────────────────────────────────────────────────┘
```

Note what this screen proves without a word of narration: the tier ladder, evidence citation, the policy rule and version, the capability token, the contact budget, the RBI pre-debit notification ordering, the injection-safe reply handling, idempotency, and reconciliation.

**Screen 3 — Incident**

Approval-rate chart with baseline band and the detection point marked; affected segment; parked case count; the staged-release ramp progressing live; the incident-intelligence RCA claim in a bordered box with its provider metadata, proposed action, and approval state.

**Screen 4 — Policy**

The active policy YAML with version, and a live counter of how many actions each rule blocked in this run. "Rule R-207 (quiet hours) blocked 34 messages" is a compliance claim with a number behind it.

**Screen 5 — Attribution**

Treated vs holdout as two labelled bars, the estimator written out as an equation with the actual numbers substituted, the exclusion counts, and the ground-truth comparison.

### 4c. Terminal view

A second surface, same SSE event stream, for the "watch it think" moment:

```
14:02:11  c_8812  DETECT    upi_autopay MANDATE_AMOUNT_EXCEEDED  ₹4,200
14:02:11  c_8812  TIER0     no match → fan out specialists
14:02:12  c_8812  CLAIM     diagnosis mandate_cap_breach 0.88 · ev_1102, ev_1104
14:02:12  c_8812  REDUCE    accepted diagnosis · no incident conflict
14:02:12  c_8812  OPTIMIZE  notify_mandate_update EV ₹1,184 · rank 1/3
14:02:12  c_8812  POLICY    ALLOW R-114 · token tk_9d3 · cap ₹3,000
14:02:12  c_8812  EXEC      whatsapp WA_MANDATE_UPD hi → +91••••4471
14:02:13  c_9007  POLICY    BLOCK R-207 quiet_hours (22:41 IST)
14:02:13  INC-01  DETECT    gw=A issuer=HDFC z=-6.4 n=412 → OPEN
14:02:13  INC-01  PARK      47 cases suspended
```

Colour-coded, monospace, scrolling. Cheap to build, and it makes the system feel alive in a way the web console does not.

---

## 5. Demo script (5 minutes)

| Time | Beat | What is on screen |
|---|---|---|
| 0:00–0:30 | **Frame the problem and the honesty.** "Revenue leaks in stages. We built the loop that closes it. The engine is real; the payment world is simulated — which means we know the ground truth and can prove our measurement is accurate. Here's a live Razorpay test-mode case first, so you know the connector is real." | Terminal, idle |
| 0:30–1:00 | **The one real case.** Trigger it. Real payment link, real payment ID, real webhook closes the case. | Case inspector, live |
| 1:00–2:00 | **Launch the batch.** 2000 cases, 20% holdout, virtual clock running. Let the terminal scroll. Point at one Tier 0 resolve, one Tier 1 fan-out/reducer decision, and one policy BLOCK on quiet hours. | Terminal |
| 2:00–2:45 | **Inject the incident.** Gateway A + HDFC degrades. One incident opens, 47 cases park rather than each retrying and messaging. Show the RCA box. Resolve it; staged release ramps 5→15→40→100 without re-triggering. | Incident screen |
| 2:45–3:30 | **Open one case fully.** The Screen 2 trail. Say nothing for ten seconds and let them read it. Then point at three lines: the policy rule + version, the capability token, and the verified mandate/pre-debit prerequisite. | Case inspector |
| 3:30–4:30 | **The number.** Gross versus estimated incremental recovery, its confidence interval, and simulator ground truth. "The honest agent number is ₹2.09 lakh, and this is its interval; the simulator lets us check that the interval contains the truth." Then cost per rupee recovered. | Batch run screen |
| 4:30–5:00 | **Close on the bar.** Stopping rules fired N times, escalations M, every action carries a rule ID and a version, replay reproduces every deterministic decision. Offer to re-run with the same seed. | Policy screen |

**Have ready but off-script:** the adapter interface file, the policy YAML and the agent-runtime ablation comparison (if anyone challenges the simulation or the use of AI).

---

## 6. Risk register

| Risk | Mitigation |
|---|---|
| Scheduler bugs surface only at demo time | Build it in Phase 1 and write property tests: fire-once, cancel-on-terminal, crash-resume |
| Venue wifi kills the live Razorpay case | Pre-record it; keep the simulated path fully offline |
| Provider latency stalls the batch on stage | Structured-claim cache keyed by role and input hash; degraded-mode fallback; Tier 1 is a minority of cases by design |
| Live adapter promises an unsupported payment action | Restrict RazorpayTestAdapter to a preflighted Payment Link or test Subscription flow; label all other actions simulated |
| Incident detector fires forty incidents | Child-segment suppression + dwell, tested against the scenario before demo day |
| Attribution number looks too good | That's the ground-truth line's job — show the error, not just the estimate |
| Optimizer scores against the simulator's own answer key | Author `p_recover` priors in `/actions/library.yaml` independently of the simulator's outcome model, and deliberately imperfectly; report optimizer regret against ground truth so the gap is visible |
| Scope creep back to four domains deep | Checkout and invoice ship as playbook config on the same engine, not new code paths |

---

## 7. What "done" means

The build is done when all of these are true:

1. `pnpm batch scenarios/demo.yaml` runs 2000 cases to terminal states under the virtual clock and prints gross, estimated incremental recovery, 95% interval, simulator ground truth and error.
2. Re-running with the same seed reproduces the output.
3. Replaying the ledger reproduces every Tier 0 decision.
4. One preflighted, supported case executes end to end against Razorpay Test Mode with a real payment ID and verified webhook.
5. Every executed action in the ledger carries a policy version, a rule ID, and a burned capability token.
6. The incident path parks and safely releases related cases; advanced anomaly statistics and routing changes remain clearly labelled when simulated.
7. A judge can open one case and understand what happened without you speaking.
8. A reviewer can clone the public repository, follow the README and reproduce the seeded synthetic demo without private credentials.
