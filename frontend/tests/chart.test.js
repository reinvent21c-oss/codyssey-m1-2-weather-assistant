import test from "node:test";
import assert from "node:assert/strict";
import { chartSeries } from "../chart.js";

test("sorts actual dates and preserves zero/negative values without changing input", () => {
  const records = [{ date: "2025-10-03", value: 5 }, { date: "2025-10-01", value: -2 }, { date: "2025-10-02", value: 0 }];
  const result = chartSeries(records);
  assert.deepEqual(result.points.map(point => [point.date, point.value]), [["2025-10-01", -2], ["2025-10-02", 0], ["2025-10-03", 5]]);
  assert.equal(result.segments.length, 1);
  assert.equal(records[0].date, "2025-10-03");
});
test("breaks missing-date segments and does not generate missing observations", () => {
  const result = chartSeries([{ date: "2025-10-01", value: 1 }, { date: "2025-10-03", value: 2 }]);
  assert.equal(result.points.length, 2); assert.equal(result.segments.length, 2);
  assert.equal(result.points[1].time - result.points[0].time, 2 * 86400000);
});
test("empty, single and 400 observations retain their exact count", () => {
  assert.deepEqual(chartSeries([]), { points: [], segments: [] });
  assert.equal(chartSeries([{ date: "2025-10-01", value: 0 }]).segments[0].length, 1);
  const rows = Array.from({ length: 400 }, (_, index) => ({ date: new Date(Date.UTC(2025, 0, 1) + index * 86400000).toISOString().slice(0, 10), value: index % 30 - 10 }));
  assert.equal(chartSeries(rows.reverse()).points.length, 400);
});
test("invalid dates, duplicates, non-finite values and injection strings are rejected", () => {
  for (const row of [{ date: "2025-02-30", value: 1 }, { date: '<svg onload="alert(1)">', value: 1 }, { date: "2025-10-01", value: "0" }, { date: "2025-10-01", value: Infinity }]) assert.throws(() => chartSeries([row]));
  assert.throws(() => chartSeries([{ date: "2025-10-01", value: 1 }, { date: "2025-10-01", value: 2 }]));
});
