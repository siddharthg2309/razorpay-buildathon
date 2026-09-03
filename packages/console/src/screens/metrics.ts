import { getPool } from "@rra/db";
import { bar, esc, kpi, page, panel, pct, rupees, table } from "../render.js";

interface Breakdown {
  key: string;
  n: number;
  recovered: number;
  rate: number;
  valuePaise: number;
  recoveredPaise: number;
}

/**
 * Recovery broken down the way the brief asks for it: by cause, rail, gateway
 * and issuer. Treated cases only — mixing the holdout in would understate every
 * row by exactly the natural-recovery rate.
 */
async function breakdown(column: string): Promise<Breakdown[]> {
  const { rows } = await getPool().query<{
    key: string; n: string; recovered: string; value: string; recovered_value: string;
  }>(
    `SELECT coalesce(c.${column}, 'unknown') AS key,
            count(*) AS n,
            count(*) FILTER (WHERE c.state = 'RECOVERED') AS recovered,
            coalesce(sum(o.amount_paise), 0) AS value,
            coalesce(sum(o.amount_paise) FILTER (WHERE c.state = 'RECOVERED'), 0) AS recovered_value
       FROM cases c JOIN obligations o ON o.id = c.obligation_id
      WHERE c.holdout_flag = false
      GROUP BY 1 ORDER BY count(*) DESC`,
  );
  return rows.map((r) => ({
    key: r.key,
    n: Number(r.n),
    recovered: Number(r.recovered),
    rate: Number(r.n) ? Number(r.recovered) / Number(r.n) : 0,
    valuePaise: Number(r.value),
    recoveredPaise: Number(r.recovered_value),
  }));
}

const renderBreakdown = (rows: Breakdown[]): string =>
  table(
    ["", "cases", "recovered", "rate", "at risk", "collected", ""],
    rows.map((r) => [
      esc(r.key),
      String(r.n),
      String(r.recovered),
      pct(r.rate),
      rupees(r.valuePaise),
      rupees(r.recoveredPaise),
      bar(r.rate),
    ]),
    [1, 2, 3, 4, 5],
  );

/** Metrics beyond the headline, per problem statement §8. */
export async function metricsScreen(): Promise<string> {
  const pool = getPool();

  // Time to recovery, from case open to terminal write. Both timestamps come
  // from the virtual clock, so these are recovery times in the simulated world.
  const { rows: ttr } = await pool.query<{ p50: string | null; p90: string | null; mean: string | null }>(
    `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - opened_at)) AS p50,
            percentile_disc(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - opened_at)) AS p90,
            avg(extract(epoch FROM closed_at - opened_at)) AS mean
       FROM cases WHERE state = 'RECOVERED' AND holdout_flag = false`,
  );
  const hours = (sec: string | null): string =>
    sec === null ? "—" : `${(Number(sec) / 3600).toFixed(1)}h`;

  // Subscription renewals collected. Reported as a breakdown, never added to
  // the headline — a recovered renewal is cash collected once, not cash plus
  // retained MRR.
  const { rows: mrr } = await pool.query<{ n: string; collected: string; at_risk: string }>(
    `SELECT count(*) FILTER (WHERE state = 'RECOVERED') AS n,
            coalesce(sum(o.amount_paise) FILTER (WHERE state = 'RECOVERED'), 0) AS collected,
            coalesce(sum(o.amount_paise), 0) AS at_risk
       FROM cases c JOIN obligations o ON o.id = c.obligation_id
      WHERE c.domain = 'subscription_renewal' AND c.holdout_flag = false`,
  );

  // Invoice aging at the moment of recovery.
  const { rows: aging } = await pool.query<{ bucket: string; n: string; value: string }>(
    `SELECT CASE
              WHEN extract(epoch FROM c.closed_at - o.due_at) / 86400 < 7 THEN '0-7d'
              WHEN extract(epoch FROM c.closed_at - o.due_at) / 86400 < 30 THEN '7-30d'
              ELSE '30d+' END AS bucket,
            count(*) AS n, coalesce(sum(o.amount_paise), 0) AS value
       FROM cases c JOIN obligations o ON o.id = c.obligation_id
      WHERE c.domain = 'overdue_invoice' AND c.state = 'RECOVERED' AND c.closed_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
  );

  const { rows: contact } = await pool.query<{ contacts: string; customers: string }>(
    "SELECT coalesce(sum(used), 0) AS contacts, count(DISTINCT customer_id) AS customers FROM contact_budgets WHERE channel <> '*'",
  );
  const { rows: cost } = await pool.query<{ recovered: string }>(
    `SELECT coalesce(sum(o.amount_paise) FILTER (WHERE c.state = 'RECOVERED'), 0) AS recovered
       FROM cases c JOIN obligations o ON o.id = c.obligation_id WHERE c.holdout_flag = false`,
  );
  const contacts = Number(contact[0]?.contacts ?? 0);
  const recoveredPaise = Number(cost[0]?.recovered ?? 0);

  return page(
    "metrics",
    "metrics",
    `<h1>Metrics beyond the headline</h1>
     <div class="kpis">
       ${kpi(hours(ttr[0]?.p50 ?? null), "time to recovery", `p90 ${hours(ttr[0]?.p90 ?? null)}`)}
       ${kpi(rupees(Number(mrr[0]?.collected ?? 0)), "renewals collected", `${mrr[0]?.n ?? 0} subscriptions retained`)}
       ${kpi(String(contacts), "customer contacts", `${contact[0]?.customers ?? 0} customers reached`)}
       ${kpi(contacts ? rupees(recoveredPaise / contacts) : "—", "collected per contact")}
     </div>
     ${panel("by cause", renderBreakdown(await breakdown("cause")))}
     ${panel("by rail", renderBreakdown(await breakdown("rail")))}
     ${panel("by gateway", renderBreakdown(await breakdown("gateway")))}
     ${panel("by issuer", renderBreakdown(await breakdown("issuer")))}
     ${panel(
       "invoice aging at recovery",
       aging.length
         ? table(["bucket", "invoices", "value"], aging.map((a) => [esc(a.bucket), a.n, rupees(Number(a.value))]), [1, 2])
         : `<p class="note">No overdue invoices recovered in this run.</p>`,
     )}
     <p class="mono-sm">Breakdowns cover the treated arm only. Including the holdout would
     understate every row by the natural-recovery rate. Renewals collected is reported as a
     breakdown and never added to the headline — a recovered renewal is cash collected once,
     not cash plus retained MRR.</p>`,
  );
}
