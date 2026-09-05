import { incidentList, releaseSteps } from "../queries.js";
import { bar, card, esc, grid, page, pageHead, pct, section, stat, table } from "../render.js";

const RAMP = [0.05, 0.15, 0.4, 1.0];

/** Incidents — one shared failure, and how its cases were let back out. */
export async function incidentsScreen(): Promise<string> {
  const incidents = await incidentList();
  if (incidents.length === 0) {
    return page(
      "Incidents",
      "/incidents",
      `${pageHead("No incident opened", "Nothing in this run crossed the detection threshold.")}
       ${card("Why that is a result", `<p class="note">A volume floor, a dwell requirement and a
         correction for testing many segments at once all have to be cleared first. Staying quiet
         is the detector working.</p>`)}`,
    );
  }

  const blocks: string[] = [];
  for (const [n, i] of incidents.entries()) {
    const steps = await releaseSteps(i.id);
    const parked = Number(i.parked);

    const detection =
      i.z_score !== null && i.sample_n
        ? table(
            ["expected", "observed", "z", "p", "attempts"],
            [[
              pct(i.baseline_rate),
              `<strong>${pct(i.observed_rate)}</strong>`,
              i.z_score.toFixed(2),
              (i.p_value ?? 1) < 0.0001 ? "&lt;0.0001" : (i.p_value ?? 1).toFixed(4),
              String(i.sample_n),
            ]],
            [0, 1, 2, 3, 4],
          )
        : `<p class="note">Opened from an external downtime signal, so there is no test
           statistic.</p>`;

    const stepRows = steps.map((s) => {
      const p = s.payload as Record<string, unknown>;
      const action = String(p["action"] ?? "");
      return [
        action === "reparked"
          ? `<span class="chip solid">pulled back</span>`
          : action === "completed"
            ? `<span class="chip">complete</span>`
            : "released",
        String(p["stage"] ?? ""),
        String(p["releasedNow"] ?? ""),
        String(p["stillParked"] ?? ""),
        esc(String(p["reason"] ?? "")),
      ];
    });

    blocks.push(`
      ${n === 0
        ? pageHead(esc(i.segment_label), `${esc(i.detected_by.replace(/_/g, " "))} · ${esc(i.state)}`)
        : `<h2>${esc(i.segment_label)}</h2>`}
      ${grid(3, [
        stat("Cases held", String(parked), "", "hero"),
        stat("Release stage", `${i.release_stage} of ${RAMP.length}`, RAMP.map((f) => `${(f * 100).toFixed(0)}%`).join(" · ")),
        stat("Approval rate", pct(i.observed_rate), `against ${pct(i.baseline_rate)} expected`),
      ])}
      ${section("Detection and release", `<div class="grid c2">
        ${card("What the detector saw", detection, "", true)}
        ${card("Letting them back out",
          `${bar(i.release_stage / RAMP.length)}
           <p class="note" style="margin-top:12px">Widening slices, each gated on the live rate
           holding. If it drops, the slice is pulled back.</p>`)}
      </div>`)}
      ${stepRows.length ? section("", card("Release steps",
        table(["step", "stage", "released", "still held", "reason"], stepRows, [1, 2, 3]), "", true)) : ""}
      ${i.rca ? section("", card("Root cause", `<pre>${esc(JSON.stringify(i.rca, null, 2))}</pre>`)) : ""}
`);
  }

  return page("Incidents", "/incidents", blocks.join(""));
}
