import { monthLabel } from "./utils/dates.js";

// Group orders ({ id, date: 'YYYY-MM-DD', amount }) by month label.
export function monthlyTotals(orders) {
  const totals = {};
  for (const order of orders) {
    const label = monthLabel(order.date);
    totals[label] = (totals[label] ?? 0) + order.amount;
  }
  return totals;
}
