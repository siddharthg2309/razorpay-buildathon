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
import { metricsScreen } from "@rra/console/screens/metrics";
import { streamScreen } from "@rra/console/screens/stream";
import { readSince } from "@rra/console/stream";

const scenario = { ...loadScenario("scenarios/demo.yaml"), size: 300 };
let recoveredCase = "";

beforeAll(async () => {
  await getPool().query(
    `TRUNCATE claim_cache, attribution_runs, incident_members, incidents, segment_windows, segment_baselines,
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
  /**
   * These assert structure and meaning, not wording.
   *
   * The previous versions matched on prose, so a copy edit broke eight tests
   * that had nothing to do with behaviour. A test that fails when a label is
   * reworded is telling you about the label, not the product.
   */

  it("keeps recovered-by-the-agent and total-collected as separate figures", async () => {
    const html = await batchScreen();
    // Two distinct rupee figures with their own captions, so neither can be
    // read as the other. Which words caption them is a copy decision.
    const captions = html.match(/class="caption">([^<]+)</g) ?? [];
    expect(captions.length).toBeGreaterThanOrEqual(2);
    const amounts = html.match(/class="amount[^"]*">([^<]+)</g) ?? [];
    expect(new Set(amounts).size).toBeGreaterThanOrEqual(2);
  });

  it("lists cases, marks the held-back arm, and links into each one", async () => {
    const html = await casesScreen();
    expect(html).toContain(`href="/case/${recoveredCase}"`);
    // Holdout cases must be visually distinguishable from treated ones.
    expect(html).toMatch(/class="mark"/);
  });

  it("shows a complete decision trail a judge can read unaided", async () => {
    expect(recoveredCase).not.toBe("");
    const html = await caseScreen(recoveredCase);

    // The audit-trail requirement, checked as content rather than layout.
    for (const marker of ["CASE OPENED", "EVIDENCE", "POLICY", "TOKEN", "EXECUTE", "SETTLEMENT"]) {
      expect(html).toContain(marker);
    }
    expect(html).toMatch(/rule R-\d+/);        // the rule that authorised it
    expect(html).toContain("policy v7");       // and which version of it
    expect(html).toMatch(/tk_[0-9a-f]{6}/);    // the capability token
    expect(html).toContain("burned");          // spent, so it cannot be reused
  });

  it("labels every executed row SIM or LIVE", async () => {
    const html = await caseScreen(recoveredCase);
    const executes = (html.match(/class="ev">EXECUTE</g) ?? []).length;
    const badges = (html.match(/class="mark(?: live)?">(?:SIM|LIVE)</g) ?? []).length;
    expect(executes).toBeGreaterThan(0);
    // This screen exists to prove the honesty claim; an unlabelled executed row
    // would show a simulated action as though it were real.
    expect(badges).toBeGreaterThanOrEqual(executes);
  });

  it("renders a case that does not exist without throwing", async () => {
    expect(await caseScreen("c_nope")).toContain("c_nope");
  });

  it("shows the incident with its detection statistics and release ramp", async () => {
    const html = await incidentsScreen();
    expect(html).toMatch(/gateway=A/);
    // The numbers that justify opening it, and the staged release.
    expect(html).toMatch(/class="bar"/);
    expect(html).toMatch(/\d+ of 4/);
  });

  it("shows every policy rule with a count behind it", async () => {
    const html = await policyScreen();
    expect(html).toMatch(/R-\d+/);
    // The active config verbatim, not a summary of it.
    expect(html).toContain("quiet_hours");
    expect(html).toContain("contact_caps");
  });

  it("writes the estimator out with this run's numbers substituted", async () => {
    const html = await attributionScreen();
    // The equation, with real values rather than symbols.
    expect(html).toMatch(/<pre>[\s\S]*?[\d.]+%[\s\S]*?<\/pre>/);
    expect(html).toMatch(/₹/);
  });

  it("renders every breakdown the brief asks for, on real queries", async () => {
    // This screen joins cases to obligations and both carry a `state` column,
    // so an unqualified reference is a runtime ambiguity error rather than a
    // compile error. It needs a test that actually executes the queries.
    const html = await metricsScreen();
    for (const heading of ["by cause", "by rail", "by gateway", "by issuer"]) {
      expect(html).toContain(heading);
    }
    expect(html).toMatch(/time to recover/i);
  });

  it("serves a stream page that subscribes to the event source", () => {
    expect(streamScreen()).toContain('EventSource("/events")');
  });

  it("renders every screen as valid, self-contained, monochrome HTML", async () => {
    const screens = await Promise.all([
      batchScreen(), casesScreen(), caseScreen(recoveredCase), incidentsScreen(),
      policyScreen(), attributionScreen(), metricsScreen(),
    ]);
    for (const html of screens) {
      expect(html.startsWith("<!doctype html>")).toBe(true);
      // No external requests: the console has to work on a venue network that
      // may not let anything out.
      expect(html).not.toMatch(/src="https?:|href="https?:/);
      // Monochrome by construction — every colour a pure grey.
      for (const hex of html.match(/#[0-9A-Fa-f]{6}/g) ?? []) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(6);
      }
    }
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
