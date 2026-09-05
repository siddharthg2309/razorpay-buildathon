import { getPool } from "@rra/db";
import { bar, card, esc, grid, page, pageHead, pct, rupees, section, stat, table } from "../render.js";

interface Breakdown {
  key: string; n: number; recovered: number; rate: number;
  valuePaise: number; recoveredPaise: number;
}

/**
 * Recovery broken down by cause, rail, gateway and issuer.
 *
 * Treated cases only. Folding the held-back arm in would understate every row
 * by exactly the rate at which money arrives on its own.
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
    key: r.key, n: Number(r.n), recovered: Number(r.recovered),
    rate: Number(r.n) ? Number(r.recovered) / Number(r.n) : 0,
    valuePaise: Number(r.value), recoveredPaise: Number(r.recovered_value),
  }));
}

const render = (rows: Breakdown[]): string =>
  table(
    ["", "cases", "recovered", "rate", "at risk", "collected", ""],
    rows.map((r) => [
      esc(r.key.replace(/_/g, " ")),
      String(r.n), String(r.recovered), pct(r.rate),
      rupees(r.valuePaise), rupees(r.recoveredPaise), bar(r.rate),
    ]),
    [1, 2, 3, 4, 5],
  );

export async function metricsScreen(): Promise<string> {
  const pool = getPool();

  const { rows: ttr } = await pool.query<{ p50: string | null; p90: string | null }>(
    `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - opened_at)) AS p50,
            percentile_disc(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - opened_at)) AS p90
       FROM cases WHERE state = 'RECOVERED' AND holdout_flag = false`,
  );
  const hours = (s: string | null): string => (s === null ? "—" : `${(Number(s) / 3600).toFixed(0)}h`);

  const { rows: mrr } = await pool.query<{ n: string; collected: string }>(
    `SELECT count(*) FILTER (WHERE c.state = 'RECOVERED') AS n,
            coalesce(sum(o.amount_paise) FILTER (WHERE c.state = 'RECOVERED'), 0) AS collected
       FROM cases c JOIN obligations o ON o.id = c.obligation_id
      WHERE c.domain = 'subscription_renewal' AND c.holdout_flag = false`,
  );

  const { rows: aging } = await pool.query<{ bucket: string; n: string; value: string }>(
    `SELECT CASE WHEN extract(epoch FROM c.closed_at - o.due_at)/86400 < 7 THEN 'under a week'
                 WHEN extract(epoch FROM c.closed_at - o.due_at)/86400 < 30 THEN 'one to four weeks'
                 ELSE 'over a month' END AS bucket,
            count(*) AS n, coalesce(sum(o.amount_paise),0) AS value
       FROM cases c JOIN obligations o ON o.id = c.obligation_id
      WHERE c.domain = 'overdue_invoice' AND c.state = 'RECOVERED' AND c.closed_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
  );

  const { rows: contact } = await pool.query<{ contacts: string; customers: string }>(
    "SELECT coalesce(sum(used),0) AS contacts, count(DISTINCT customer_id) AS customers FROM contact_budgets WHERE channel <> '*'",
  );
  const { rows: cost } = await pool.query<{ recovered: string }>(
    `SELECT coalesce(sum(o.amount_paise) FILTER (WHERE c.state='RECOVERED'),0) AS recovered
       FROM cases c JOIN obligations o ON o.id = c.obligation_id WHERE c.holdout_flag = false`,
  );
  const contacts = Number(contact[0]?.contacts ?? 0);
  const recoveredPaise = Number(cost[0]?.recovered ?? 0);

  return page(
    "Breakdown",
    "/metrics",
    `${pageHead("Beyond the headline", "Where the recovery came from, and what it cost in contacts.")}
     ${grid(4, [
       stat("Typical time to recover", hours(ttr[0]?.p50 ?? null), `slowest tenth ${hours(ttr[0]?.p90 ?? null)}`),
       stat("Renewals collected", rupees(Number(mrr[0]?.collected ?? 0)), `${mrr[0]?.n ?? 0} kept · not in the headline`),
       stat("Customers contacted", String(contacts), `${contact[0]?.customers ?? 0} distinct customers`),
       stat("Collected per contact", contacts ? rupees(recoveredPaise / contacts) : "—"),
     ])}
     ${section("By cause", render(await breakdown("cause")))}
     ${section("By rail", render(await breakdown("rail")))}
     ${section("By gateway", render(await breakdown("gateway")))}
     ${section("By issuer", render(await breakdown("issuer")))}
     ${section("Invoice age at recovery",
       aging.length
         ? table(["age at recovery", "invoices", "value"],
             aging.map((a) => [esc(a.bucket), a.n, rupees(Number(a.value))]), [1, 2])
         : `<p class="empty">No overdue invoices recovered in this run.</p>`)}`,
  );
}
