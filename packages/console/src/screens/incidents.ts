import { incidentList, releaseSteps } from "../queries.js";
import { bar, esc, head, hint, measure, measures, page, pct, section, table } from "../render.js";

const RAMP = [0.05, 0.15, 0.4, 1.0];

/** Incidents — one shared failure, and how its cases were let back out. */
export async function incidentsScreen(): Promise<string> {
  const incidents = await incidentList();
  if (incidents.length === 0) {
    return page(
      "incidents",
      "incidents",
      `${head("No incident opened", "Nothing in this run crossed the detection threshold.")}
       <p class="note">That is a result, not an absence. A fault confined to a few dozen cases is
       genuinely indistinguishable from noise, and the detector is built to stay quiet rather than
       open something it cannot justify.</p>`,
    );
  }

  const blocks: string[] = [];
  for (const i of incidents) {
    const steps = await releaseSteps(i.id);
    const parked = Number(i.parked);

    const detection =
      i.z_score !== null && i.sample_n
        ? table(
            ["expected", "observed", "z", "p", "attempts"],
            [[
              pct(i.baseline_rate),
              `<span class="key">${pct(i.observed_rate)}</span>`,
              i.z_score.toFixed(2),
              (i.p_value ?? 1) < 0.0001 ? "&lt;0.0001" : (i.p_value ?? 1).toFixed(4),
              String(i.sample_n),
            ]],
            [0, 1, 2, 3, 4],
          )
        : `<p class="note">Opened from an external downtime signal rather than the internal
           detector, so there is no test statistic to show. Both paths converge on one record.</p>`;

    const stepRows = steps.map((s) => {
      const p = s.payload as Record<string, unknown>;
      const action = String(p["action"] ?? "");
      return [
        action === "reparked" ? `<span class="key">pulled back</span>`
          : action === "completed" ? `<span class="key">complete</span>`
          : "released",
        String(p["stage"] ?? ""),
        String(p["releasedNow"] ?? ""),
        String(p["stillParked"] ?? ""),
        esc(String(p["reason"] ?? "")),
      ];
    });

    blocks.push(`
      ${head(esc(i.segment_label), `${esc(i.detected_by.replace(/_/g, " "))} · ${esc(i.state)}`)}
      ${measures([
        measure(String(parked), "cases held", "not retrying on their own"),
        measure(`${i.release_stage} of ${RAMP.length}`, "release stage"),
        measure(pct(i.observed_rate), "approval rate", `against ${pct(i.baseline_rate)} expected`),
      ])}
      ${section("what the detector saw", detection)}
      ${section("letting them back out", `
        ${bar(i.release_stage / RAMP.length)}
        <p class="note" style="margin-top:14px">Released in widening slices —
        ${RAMP.map((f) => `${(f * 100).toFixed(0)}%`).join(", ")} — each gated on the live rate
        holding. If it drops, the slice is pulled back rather than pressing on.</p>
        ${stepRows.length ? table(["step", "stage", "released", "still held", "reason"], stepRows, [1, 2, 3]) : ""}`)}
      ${i.rca ? section("what caused it", `<pre>${esc(JSON.stringify(i.rca, null, 2))}</pre>`) : ""}
      ${hint(`The incident owns these cases, not the other way round. A held case cannot resume
        itself, which is what stops a thousand of them returning at once to a gateway that has
        only just recovered.`)}`);
  }

  return page("incidents", "incidents", blocks.join(""));
}
