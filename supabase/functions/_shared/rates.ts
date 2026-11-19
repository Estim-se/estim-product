// Hourly rate suggestions from extracted invoice rows. Plain code, no AI.

/**
 * Proposes an hourly rate per role as the MEDIAN of hourly labour rows.
 * Rows older than 18 months and outliers (>30 % from the median) are returned
 * separately so the craftsman can decide. Used per file in extract-prices; run it again
 * on rows from all files before showing the price list.
 */
export function summarizeRates(items: Array<{ typ: string; unit: string | null; role: string | null;
  unit_price_ex_vat: number | null; date: string | null; source: unknown }>) {
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 18);
  const byRole = new Map<string, typeof items>();
  for (const i of items) {
    if (i.typ !== "arbete" || i.unit_price_ex_vat == null) continue;
    if (!/^(h|tim|timmar?)$/i.test(i.unit ?? "")) continue;
    const role = i.role ?? "okänd roll";
    byRole.set(role, [...(byRole.get(role) ?? []), i]);
  }
  return [...byRole.entries()].map(([role, rows]) => {
    const recent = rows.filter((r) => !r.date || new Date(r.date) >= cutoff);
    const prices = recent.map((r) => r.unit_price_ex_vat!).sort((a, b) => a - b);
    const median = prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null;
    const outliers = median == null ? [] : recent.filter((r) => Math.abs(r.unit_price_ex_vat! - median) / median > 0.3);
    return {
      role,
      hourly_rate_ex_vat: median,
      based_on: prices.length,
      old_rows: rows.filter((r) => r.date && new Date(r.date) < cutoff).map((r) => r.source),
      outliers: outliers.map((r) => ({ price: r.unit_price_ex_vat, source: r.source })),
    };
  });
}
