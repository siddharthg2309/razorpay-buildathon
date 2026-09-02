import { incidentList, releaseSteps } from "../queries.js";
import { bar, esc, kpi, page, panel, pct, table } from "../render.js";

const RAMP = [0.05, 0.15, 0.4, 1.0];

/** Screen 3 — incident. */
export async function incidentsScreen(): Promise<string> {
  const incidents = await incidentList();
  if (incidents.length === 0) {
    return page("incidents", "incidents", panel("no incidents", `<p class="note">None opened in this run.</p>`));
  }

  const blocks: string[] = [];
  for (const i of incidents) {
    const steps = await releaseSteps(i.id);
    const parked = Number(i.parked);

    const detection = i.z_score !== null && i.sample_n
      ? table(
          ["baseline", "observed", "z", "p", "n"],
          [[
            pct(i.baseline_rate),
            `<span style="color:var(--err)">${pct(i.observed_rate)}</span>`,
            i.z_score.toFixed(2),
            (i.p_value ?? 1) < 0.0001 ? "<0.0001" : (i.p_value ?? 1).toFixed(4),
            String(i.sample_n),
          ]],
          [0, 1, 2, 3, 4],
        )
      : `<p class="note">Opened from an external downtime signal, not the internal detector — so
         there is no z-score to show. The two paths converge on the same incident record.</p>`;

    const rampCells = RAMP.map((f, idx) => {
      const done = i.release_stage > idx;
      return `<td class="num" style="${done ? "color:var(--accent)" : "color:var(--ink-3)"}">${(f * 100).toFixed(0)}%</td>`;
    }).join("");

    const stepRows = steps.map((s) => {
      const p = s.payload as Record<string, unknown>;
      const action = String(p["action"] ?? "");
      const colour = action === "reparked" ? "var(--err)" : action === "completed" ? "var(--ok)" : "var(--ink)";
      return [
        `<span style="color:${colour}">${esc(action)}</span>`,
        String(p["stage"] ?? ""),
        String(p["releasedNow"] ?? ""),
        String(p["stillParked"] ?? ""),
        `<span class="note">${esc(p["reason"])}</span>`,
      ];
    });

    blocks.push(`
      <h1>${esc(i.id)} · ${esc(i.segment_label)}</h1>
      <div class="kpis">
        ${kpi(i.state.toUpperCase(), "state")}
        ${kpi(String(parked), "cases parked", "not retrying independently")}
        ${kpi(`${i.release_stage}/4`, "release stage")}
        ${kpi(esc(i.detected_by), "detected by")}
      </div>
      ${panel("detection", detection)}
      ${panel("staged release", `<table><tbody><tr><td class="dim">ramp</td>${rampCells}</tr></tbody></table>
        ${bar(i.release_stage / RAMP.length)}
        ${stepRows.length ? table(["step", "stage", "released", "still parked", "reason"], stepRows, [1, 2, 3]) : `<p class="note">No release steps yet.</p>`}`)}
      ${i.rca ? panel("root cause narrative", `<pre>${esc(JSON.stringify(i.rca, null, 2))}</pre>`) : ""}
      <p class="mono-sm">The incident, not the case, owns resumption. Parked cases have their
      scheduled actions cancelled and re-created by the release controller — they never resume
      themselves, which is what stops a thousand cases from re-degrading a gateway that has only
      just recovered.</p>`);
  }

  return page("incidents", "incidents", blocks.join("<hr style='border:0;border-top:1px solid var(--rule);margin:26px 0'>"));
}
