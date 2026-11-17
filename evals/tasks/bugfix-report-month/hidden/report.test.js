import assert from "node:assert/strict";
import { test } from "node:test";
import { monthlyTotals } from "../src/report.js";
import { monthLabel } from "../src/utils/dates.js";

test("labels", () => {
  assert.equal(monthLabel("2026-03-15"), "Mar 2026");
  assert.equal(monthLabel("2026-01-01"), "Jan 2026");
  assert.equal(monthLabel("2025-12-31"), "Dec 2025");
});
test("totals", () => {
  assert.deepEqual(monthlyTotals([{ date: "2026-03-15", amount: 10 }, { date: "2026-03-02", amount: 5 }, { date: "2026-01-09", amount: 1 }]), { "Mar 2026": 15, "Jan 2026": 1 });
});
