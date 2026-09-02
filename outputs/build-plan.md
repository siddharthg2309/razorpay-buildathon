# Revenue Recovery Agent — Build & Demo Plan

**Companion to:** `revenue-recovery-architecture-v2.md`
**Scope:** everything from empty repo to a demo that shows a rupee figure a judge can trust.

---

## 0. The two facts that shape this plan

1. **The bar is "measured money recovered across a batch."** So the build is not done when one case works end to end. It is done when a batch of a few hundred cases runs, a holdout splits, and a number comes out with a denominator.

2. **We are not integrating with live production anything.** Real declines don't arrive on demand, a 14-day dunning sequence doesn't fit in a demo slot, and there is no live merchant traffic to detect an incident in. So the simulation substrate is not a shortcut we apologise for — it is **a first-class deliverable engineered from Phase 0**, and it is what makes the batch number provable rather than asserted.

The honest framing on stage, said plainly and early: *"The engine is real. The payment world it acts on is simulated, with one live Razorpay test-mode case to show the connector is real. Because the world is simulated, we know the ground truth — which means we can show you that our attribution estimate is accurate to within a few percent. You can't do that with production data."*

That turns the biggest apparent weakness into the strongest claim in the room.

---

## 1. Stack and repo layout

**TypeScript monorepo.** One language across engine, simulator, and UI means less context-switching at hackathon pace, and the type definitions for cases/actions/events are shared rather than duplicated.

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript |
| DB | Postgres (`FOR UPDATE SKIP LOCKED` is the scheduler primitive; JSONB for evidence/ledger) |
| Migrations | drizzle or plain SQL files — no ORM ceremony |
| Queue | in-process worker loop over the `scheduled_actions` table; no external broker |
| LLM | `@anthropic-ai/sdk` — Opus 5 / Sonnet 5 / Haiku 4.5 per the routing table |
| Web console | Next.js + Tailwind, server components where possible |
| Terminal view | plain Node + `chalk`, reading the same event stream over SSE |
| Charts | hand-rolled SVG — no chart lib, the visuals here are simple and a library is a dependency risk |

```
/packages
  /core          types, case state machine, policy engine, taxonomy
  /engine        L0–L7 workers: ingest, detect, reason, govern, act, verify
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
- Shared types: `Case`, `Obligation`, `Evidence`, `Action`, `Plan`, `LedgerEntry`.
- Append-only `ledger` writer with a single `append(caseId, actor, type, payload)`.

**Done when:** `pnpm test` runs, a ledger row can be written and read back, and the virtual clock can be advanced.

### Phase 1 — Case fabric + scheduler (6h, P1)

- `obligations`, `cases` tables; case state machine with explicit legal transitions (reject illegal ones loudly).
- Obligation dedup on `(merchant, external_ref)`; obligation lease table.
- **Durable scheduler**: `scheduled_actions`, leased tick worker, cancel-on-terminal in the same transaction.

**Done when:** you can schedule an action 3 virtual days out, advance the clock, and watch it fire exactly once — and cancelling the case cancels it.

*This phase is the spine. If it is shaky, everything downstream is.*

### Phase 2 — Evidence + Tier 0 (5h, P1)

- Evidence board: typed, append-only, each row carries source and observation time.
- **Decline taxonomy for India rails** — cards, UPI AutoPay, e-NACH, netbanking, wallets. Hard vs soft, retry eligibility, per-code ceiling.
- Deterministic classifier: `(rail, code, context) → cause, confidence, rule_id`.
- Playbook table: `(domain, cause) → default plan`.

**Done when:** a simulated `payment_failed` with `INSUFFICIENT_FUNDS` on UPI AutoPay produces a cause, a confidence, a rule ID, and a plan — with zero model calls.

### Phase 3 — Policy engine + capability tokens (5h, P1)

- Policy as versioned YAML per merchant: retry caps, contact caps, quiet hours, amount thresholds requiring approval, allowed actions per rail.
- Rules engine evaluating a plan → `allow | block | require_approval` + reason + rule ID.
- **Capability token minter** (HMAC) and `token_burns` table with unique index.
- **Budget ledgers**: contact budget with atomic decrement, retry counter, spend counter.

**Done when:** an over-cap contact attempt is blocked with a named rule, and replaying a burned token is rejected.

### Phase 4 — Connectors + executor (5h, P1)

- `PSPAdapter` interface: `chargeRetry`, `createPaymentLink`, `sendMessage`, `updateRouting`, `fetchPaymentStatus`.
- **`SimulatedPSP`** — see §3.
- **`RazorpayTestAdapter`** — Orders, Payments, Payment Links, Subscriptions, Invoices, Webhooks. Signature verification on inbound.
- Idempotent executor: write `action_attempts` row **before** the call, reconcile `in_flight` rows on boot.
- Connector admission check rejecting any call without a valid unburned token.

**Done when:** the same plan executes against either adapter with no engine changes, and a killed process mid-call reconciles rather than double-charging.

### Phase 5 — Verifier + reconciler (3h, P1)

- Outcome verifier: consumes settlement/status events, decides the next case state.
- Reconciler: match money received to the obligation. For B2B, Smart Collect virtual account matching.
- Terminal-state writer that cancels pending scheduled actions atomically.

**Done when:** a successful retry moves the case to `RECOVERED` and the remaining dunning steps vanish from the schedule.

### Phase 6 — The LLM tier (6h, P1)

Implement the five call sites from architecture §4. For each:

- Frozen system prompt with `cache_control` on the last stable block.
- `output_config.format` JSON schema — the model returns structured data, never prose the engine has to parse.
- Bounded input assembled from evidence refs, PII-redacted.
- Injection posture: reply interpreter returns enum + fields only, no tool access.
- **Degraded-mode fallback** to the Tier 0 playbook.

**Done when:** an unmapped decline code routes to Tier 1, the synthesizer returns a schema-valid hypothesis citing evidence IDs, the planner returns action IDs from the library only, and `cache_read_input_tokens > 0` on the second case.

### Phase 7 — Incident mode (6h, P2)

- Rolling metric windows per segment; seasonal baseline store.
- Detector per architecture §8a: volume floor, z-test, dwell, BH, child suppression, auto-close.
- Incident graph, case attachment, `suppressed_by_incident`.
- **Release controller**: ramp + jitter + circuit breaker.
- Reroute action with canary, auto-rollback, TTL.

**Done when:** injecting a gateway degradation opens exactly one incident (not forty), parks the affected cases, and staged release resumes them without re-triggering the detector.

*This is the differentiator. Protect its time.*

### Phase 8 — Attribution + batch runner (4h, P1)

- Holdout assignment at case creation: stratified by cause and value band, written immutably.
- Estimator per architecture §10, with per-domain measurement windows and exclusion rules.
- **Batch runner**: load a scenario, create N cases, run to completion under the virtual clock, emit the attribution report.

**Done when:** `pnpm batch scenarios/demo.yaml` prints gross recovered, incremental recovered, holdout rate, treated rate, and cost per rupee.

### Phase 9 — Simulator + ground truth (5h, P1)

See §3 in full. Deliverables: latent customer model, outcome model, scenario loader, event injector, seeded RNG, ground-truth reporter.

**Done when:** the same seed produces byte-identical batch output twice, and the ground-truth reporter prints the true incremental recovery next to the estimated one.

### Phase 10 — UI (8h, P1)

See §4. Web console (5 screens) + terminal stream view.

**Done when:** a judge can click one case and read its complete decision trail without you narrating it.

### Phase 11 — Demo hardening (4h, P1)

- Seed lock, dry runs, a `--reset` that returns to a known state in under 5 seconds.
- Ledger replay verifier: replay reproduces every Tier 0 decision.
- The one live Razorpay test-mode case, pre-flighted.
- Fallback recording of the full run in case the venue wifi dies.

### Cut ladder

If time runs out, cut in this order: Phase 7 reroute/canary → checkout + invoice playbooks → terminal view → Hinglish voice → incident mode entirely. **Never cut:** scheduler, capability tokens, attribution, batch runner, simulator. Those five are the demo.

---

## 3. Demo strategy — how to show this without live integrations

### 3a. The adapter seam

Everything the engine does to the outside world goes through `PSPAdapter`. Two implementations, chosen by config. **The engine cannot tell them apart** — that is the point, and it is a claim you can make on stage while showing the interface file.

```ts
interface PSPAdapter {
  chargeRetry(req: RetryRequest, token: CapabilityToken): Promise<PaymentResult>
  createPaymentLink(req: LinkRequest, token: CapabilityToken): Promise<Link>
  sendMessage(req: MessageRequest, token: CapabilityToken): Promise<Delivery>
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
  size: 300
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
holdout: 0.10
injections:
  - at: T+2h
    type: gateway_degradation
    segment: { gateway: A, issuer: HDFC, method: card }
    approval_drop: 0.55
    duration: 40m
```

The `unmapped_code` slice exists purely so Tier 1 fires during the demo and you can point at a case the model actually resolved.

### 3e. Determinism and replay

- One seed drives customer generation, outcome sampling, and injection timing. Same seed, same run, every time — so you can rehearse the demo and so a judge can ask you to run it again.
- Tier 1 model calls are the only non-deterministic element. Cache their responses keyed by input hash so a replay is fully reproducible; the cache is transparent and shown in the UI.
- **Ledger replay verifier**: re-run the ledger through the engine and assert every Tier 0 decision reproduces. This is how you *prove* the audit trail rather than just displaying a table of it.

### 3f. The one real thing

Run a single case against `RazorpayTestAdapter` live: create a real test-mode payment link, show the real payment ID, let the real webhook come back and close the case. One case, thirty seconds. It converts "simulated" from a category to a scope: *the world is simulated, the connector is not.*

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

**Rules:** IBM Plex Mono or JetBrains Mono throughout. 1px solid borders, no shadows, no gradients, no rounded corners beyond 2px. Numbers tabular-aligned. One accent colour only — it marks the thing you want looked at, and nothing else. State colours are used only on state.

This also happens to echo the dark/brass palette of the Track 03 card itself, which reads as deliberate.

### 4b. Screens

**Screen 1 — Batch Run (the money screen)**

```
┌─ RUN acme-subscriptions ─ seed 20260902 ─ T+14d ────── COMPLETE ─┐
│                                                                  │
│   ₹ 8,42,000        ₹ 2,08,900        ₹ 2,14,300         2.5%   │
│   AT RISK           INCREMENTAL       TRUE (SIM)         ERROR   │
│                     RECOVERED         GROUND TRUTH               │
│                                                                  │
│   gross recovered  ₹ 3,11,400   ·   treated 270   holdout 30    │
│   treated rate       41.2%      ·   holdout rate      17.4%     │
│   cost / ₹ recovered  ₹0.031    ·   model spend    ₹ 412        │
├──────────────────────────────────────────────────────────────────┤
│  TIER      cases    resolved    │  TERMINAL STATE       cases     │
│  ── T0       241        198     │  RECOVERED              117     │
│  ── T1        48         39     │  UNRECOVERABLE           74     │
│  ── T2        11          6     │  STOPPED (rule)          61     │
│                                 │  DISPUTED / OPTED OUT    18     │
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
│ T+0h01  DIAGNOSING    T0 no match → escalate                     │
│                       ↳ T1 synthesizer  claude-sonnet-5          │
│                         cause: mandate_cap_breach   conf 0.88    │
│                         cites: ev_1102, ev_1104                  │
│ T+0h01  PLANNING      T1 planner  claude-opus-5                  │
│                       1. notify_mandate_update  (link)           │
│                       2. wait 48h                                │
│                       3. retry_within_cap ₹3,000                 │
│                       stop: paid | opt-out | attempt 3           │
│ T+0h01  POLICY        ALLOW  rule R-114 (upi.cap_breach)         │
│                       policy v7 · token tk_9d3 · cap ₹3,000      │
│ T+0h01  EXECUTE       whatsapp template WA_MANDATE_UPD (hi)      │
│                       budget 1/2 in 7d · quiet hours OK          │
│ T+2h14  OBSERVE       inbound reply → interpreter (haiku-4-5)    │
│                       intent: WILL_UPDATE   ← treated as data    │
│ T+2d01  EXECUTE       pre-debit notification  (RBI, T-24h)       │
│ T+3d01  EXECUTE       retry ₹3,000  idem 7c2f…  token tk_a41     │
│ T+3d01  VERIFY        captured ₹3,000 · reconciled to ob_4471    │
│ T+3d01  TERMINAL      RECOVERED                                  │
└──────────────────────────────────────────────────────────────────┘
```

Note what this screen proves without a word of narration: the tier ladder, evidence citation, the policy rule and version, the capability token, the contact budget, the RBI pre-debit notification ordering, the injection-safe reply handling, idempotency, and reconciliation.

**Screen 3 — Incident**

Approval-rate chart with baseline band and the detection point marked; affected segment; parked case count; the staged-release ramp progressing live; the LLM's RCA narrative in a bordered box with its proposed action and the approval state.

**Screen 4 — Policy**

The active policy YAML with version, and a live counter of how many actions each rule blocked in this run. "Rule R-207 (quiet hours) blocked 34 messages" is a compliance claim with a number behind it.

**Screen 5 — Attribution**

Treated vs holdout as two labelled bars, the estimator written out as an equation with the actual numbers substituted, the exclusion counts, and the ground-truth comparison.

### 4c. Terminal view

A second surface, same SSE event stream, for the "watch it think" moment:

```
14:02:11  c_8812  DETECT    upi_autopay MANDATE_AMOUNT_EXCEEDED  ₹4,200
14:02:11  c_8812  TIER0     no match → escalate
14:02:12  c_8812  TIER1     synth(sonnet-5) mandate_cap_breach 0.88
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
| 1:00–2:00 | **Launch the batch.** 300 cases, 10% holdout, virtual clock running. Let the terminal scroll. Point at one Tier 0 resolve, one Tier 1 escalation, and one policy BLOCK on quiet hours. | Terminal |
| 2:00–2:45 | **Inject the incident.** Gateway A + HDFC degrades. One incident opens, 47 cases park rather than each retrying and messaging. Show the RCA box. Resolve it; staged release ramps 5→15→40→100 without re-triggering. | Incident screen |
| 2:45–3:30 | **Open one case fully.** The Screen 2 trail. Say nothing for ten seconds and let them read it. Then point at three lines: the policy rule + version, the capability token, and the RBI pre-debit notification scheduled before the retry. | Case inspector |
| 3:30–4:30 | **The number.** Gross vs incremental vs ground truth, with the error percentage. "Most demos would show you ₹3.1 lakh. The honest number is ₹2.09 lakh, and here's the proof our estimate is right." Then cost per rupee recovered. | Batch run screen |
| 4:30–5:00 | **Close on the bar.** Stopping rules fired N times, escalations M, every action carries a rule ID and a version, replay reproduces every deterministic decision. Offer to re-run with the same seed. | Policy screen |

**Have ready but off-script:** the Hinglish WhatsApp/voice recovery (a strong 20-second aside if the room is engaged), and the adapter interface file (if anyone challenges the simulation).

---

## 6. Risk register

| Risk | Mitigation |
|---|---|
| Scheduler bugs surface only at demo time | Build it in Phase 1 and write property tests: fire-once, cancel-on-terminal, crash-resume |
| Venue wifi kills the live Razorpay case | Pre-record it; keep the simulated path fully offline |
| Model latency stalls the batch on stage | Response cache keyed by input hash; degraded-mode fallback; Tier 1 is a minority of cases by design |
| Incident detector fires forty incidents | Child-segment suppression + dwell, tested against the scenario before demo day |
| Attribution number looks too good | That's the ground-truth line's job — show the error, not just the estimate |
| Scope creep back to four domains deep | Checkout and invoice ship as playbook config on the same engine, not new code paths |

---

## 7. What "done" means

The build is done when all of these are true:

1. `pnpm batch scenarios/demo.yaml` runs 300 cases to terminal states under the virtual clock and prints gross, incremental, ground truth, and error.
2. Re-running with the same seed reproduces the output.
3. Replaying the ledger reproduces every Tier 0 decision.
4. One case executes end to end against Razorpay test mode with a real payment ID.
5. Every executed action in the ledger carries a policy version, a rule ID, and a burned capability token.
6. The incident path parks, resolves, and staged-releases without oscillating.
7. A judge can open one case and understand what happened without you speaking.
