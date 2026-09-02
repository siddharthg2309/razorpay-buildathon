import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@rra/db";
import { loadScenario, runBatch } from "@rra/sim";
import { IncidentManager } from "@rra/engine";
import { VirtualClock } from "@rra/core";
import { batchScreen } from "@rra/console/screens/batch";
import { caseScreen, casesScreen } from "@rra/console/screens/cases";
import { incidentsScreen } from "@rra/console/screens/incidents";
import { policyScreen } from "@rra/console/screens/policy";
import { attributionScreen } from "@rra/console/screens/attribution";
import { streamScreen } from "@rra/console/screens/stream";
import { readSince } from "@rra/console/stream";

const scenario = { ...loadScenario("scenarios/demo.yaml"), size: 300 };
let recoveredCase = "";

beforeAll(async () => {
  await getPool().query(
    `TRUNCATE attribution_runs, incident_members, incidents, segment_windows, segment_baselines,
              settlements, action_attempts, token_burns, capability_tokens, policy_decisions,
              contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks,
              case_revisions, case_events, evidence, ledger, cases, obligations, customers,
              merchants CASCADE`,
  );
  await runBatch({ scenario, arm: "full", provider: null });
  const { rows } = await getPool().query<{ id: string }>(
    "SELECT id FROM cases WHERE state = 'RECOVERED' AND holdout_flag = false ORDER BY id LIMIT 1",
  );
  recoveredCase = rows[0]?.id ?? "";

  // Seed an incident for the screen test. At 300 cases the detector correctly
  // declines to fire — the volume floor doing its job — and the screen is what
  // is under test here, not detection, which has its own suite.
  const incidents = new IncidentManager(new VirtualClock(new Date("2026-09-02T09:00:00Z")));
  const incidentId = await incidents.openFromDowntime({ gateway: "A", issuer: "HDFC" });
  const live = await getPool().query<{ id: string }>(
    "SELECT id FROM cases WHERE closed_at IS NULL LIMIT 12",
  );
  await incidents.attachAndSuppress(incidentId, live.rows.map((r) => r.id));
  await incidents.recordRca(incidentId, { narrative: "issuer-side timeout", surface: "simulated" });
}, 180_000);

afterAll(async () => { await closePool(); });

describe("console screens", () => {
  it("renders the batch screen with gross and incremental kept apart", async () => {
    const html = await batchScreen();
    expect(html).toContain("gross recovered");
    expect(html).toContain("est. incremental");
    // The distinction is the point of the screen, so it is stated on it.
    expect(html).toContain("Gross is every rupee that arrived");
  });

  it("lists cases and links into each one", async () => {
    const html = await casesScreen();
    expect(html).toContain(`href="/case/${recoveredCase}"`);
    expect(html).toContain("HOLDOUT");
  });

  it("shows a complete decision trail a judge can read unaided", async () => {
    expect(recoveredCase).not.toBe("");
    const html = await caseScreen(recoveredCase);

    // Everything the audit-trail requirement asks for, on one screen.
    for (const marker of [
      "CASE_OPENED", "EVIDENCE", "POLICY", "TOKEN", "EXECUTE", "SETTLEMENT", "TERMINAL_REACHED",
    ]) {
      expect(html).toContain(marker);
    }
    // The policy rule and version that authorised the action.
    expect(html).toMatch(/rule R-\d+/);
    expect(html).toContain("policy v7");
    // The capability token behind the execution.
    expect(html).toMatch(/tk_[0-9a-f]{6}/);
    expect(html).toContain("burned");
  });

  it("labels every executed row SIM or LIVE", async () => {
    const html = await caseScreen(recoveredCase);
    const executes = (html.match(/class="ev">EXECUTE</g) ?? []).length;
    const badges = (html.match(/tag (sim|live)/g) ?? []).length;
    expect(executes).toBeGreaterThan(0);
    // This screen exists to prove the honesty claim; an unlabelled executed row
    // would show a simulated action as though it were real.
    expect(badges).toBeGreaterThanOrEqual(executes);
  });

  it("renders a case that does not exist without throwing", async () => {
    expect(await caseScreen("c_nope")).toContain("No case");
  });

  it("shows the incident with its detection statistics and ramp", async () => {
    const html = await incidentsScreen();
    expect(html).toContain("cases parked");
    expect(html).toMatch(/gateway=A/);
    expect(html).toContain("release stage");
    expect(html).toContain("The incident, not the case, owns resumption");
  });

  it("shows policy rules with a count behind each", async () => {
    const html = await policyScreen();
    expect(html).toContain("actions blocked");
    expect(html).toMatch(/R-\d+/);
    // The active config, verbatim, not a summary of it.
    expect(html).toContain("quiet_hours");
    expect(html).toContain("ALL CHANNELS");
  });

  it("writes the estimator out with this run's numbers substituted", async () => {
    const html = await attributionScreen();
    expect(html).toContain("rate_treated");
    expect(html).toContain("mean_value_at_risk");
    expect(html).toContain("applied symmetrically to both arms");
  });

  it("serves a stream page that subscribes to the event source", () => {
    const html = streamScreen();
    expect(html).toContain("EventSource(\"/events\")");
  });
});

describe("event stream", () => {
  it("returns ledger-backed lines both surfaces render", async () => {
    const lines = await readSince(0, 100);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.id).toBeGreaterThan(0);
      expect(l.caseId).toBeTruthy();
      expect(l.text).toBeTruthy();
    }
    expect(lines.map((l) => l.kind)).toContain("TIER0");
  });

  it("is a cursor, so a reconnect resumes rather than replaying", async () => {
    const first = await readSince(0, 10);
    const next = await readSince(first.at(-1)!.id, 10);
    expect(next.every((l) => l.id > first.at(-1)!.id)).toBe(true);
  });
});
