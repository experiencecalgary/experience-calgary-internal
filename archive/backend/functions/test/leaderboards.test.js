"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../lib/leaderboards");

function order(overrides = {}) {
  return {
    datePaid: "2026-08-08T18:00:00.000Z",
    status: "completed",
    salesRepId: "10",
    programDirectorRepId: "20",
    directorRepId: "30",
    tier: "signature",
    total: "99.00",
    ...overrides,
  };
}

test("qualifies a genuinely paid positive-revenue membership", () => {
  const actual = _test.qualifyLeaderboardOrder(order());
  assert.equal(actual.xValue, 100);
  assert.equal(actual.revenue, 99);
  assert.equal(actual.salesRepId, "10");
});

test("excludes free, unpaid, missing-rep, zero-X, and refunded orders", () => {
  assert.equal(_test.qualifyLeaderboardOrder(order({ total: "0.00" })), null);
  assert.equal(_test.qualifyLeaderboardOrder(order({ datePaid: null })), null);
  assert.equal(_test.qualifyLeaderboardOrder(order({ salesRepId: "" })), null);
  assert.equal(_test.qualifyLeaderboardOrder(order({ tier: "unknown", xValue: 0 })), null);
  assert.equal(_test.qualifyLeaderboardOrder(order({ status: "partially-refunded" })), null);
  assert.equal(_test.qualifyLeaderboardOrder(order({ payloadRaw: { refunds: [{ id: 1 }] } })), null);
});

test("does not substitute WooCommerce creation date for datePaid", () => {
  const raw = order({
    datePaid: null,
    payloadRaw: { date_created: "2026-08-08T10:00:00", total: "99.00" },
  });
  assert.equal(_test.parseActualDatePaid(raw), null);
  assert.equal(_test.qualifyLeaderboardOrder(raw), null);
});

test("accepts payload date_paid and discounted positive revenue", () => {
  const actual = _test.qualifyLeaderboardOrder(order({
    datePaid: null,
    total: undefined,
    payloadRaw: { date_paid: "2026-08-08T10:00:00-06:00", total: "25.00" },
  }));
  assert.equal(actual.revenue, 25);
  assert.equal(actual.xValue, 100);
});

test("uses Edmonton calendar month at UTC boundary", () => {
  assert.equal(_test.getEdmontonMonthKey(new Date("2026-09-01T05:59:59.999Z")), "2026-08");
  assert.equal(_test.getEdmontonMonthKey(new Date("2026-09-01T06:00:00.000Z")), "2026-09");
});

test("all boards share one eligible order set and preserve attribution rules", () => {
  const users = [
    { repId: "10", fullName: "Rep", roleId: "ROLE1", roleName: "Rep", programDirectorRepId: "20", directorRepId: "30" },
    { repId: "20", fullName: "PD", roleId: "ROLE7", roleName: "PD", programDirectorRepId: "20", directorRepId: "30" },
    { repId: "30", fullName: "Director", roleId: "ROLE8", roleName: "Director", programDirectorRepId: "30", directorRepId: "30" },
  ];
  const eligibleOrders = [order(), order({ salesRepId: "20", programDirectorRepId: "20" })]
    .map(_test.qualifyLeaderboardOrder);
  const boards = _test.buildAllBoards({
    users,
    eligibleOrders,
    repStats: new Map(),
    monthKey: "2026-08",
    payPeriodStart: new Date("2026-08-01T06:00:00.000Z"),
    payPeriodEnd: new Date("2026-08-16T06:00:00.000Z"),
    payPeriodLabel: "2026-08-01 - 2026-08-15",
  });
  const byId = new Map(boards.map((item) => [item.id, item.payload]));
  assert.equal(byId.get("rep_current_month_x").rows.find((row) => row.repId === "10").totalX, 100);
  assert.equal(byId.get("pd_current_month_pod_x").rows[0].totalX, 200);
  assert.equal(byId.get("director_current_month_org_x").rows[0].totalX, 200);
  assert.deepEqual(
    byId.get("rep_current_month_x").rows.map((row) => [row.repId, row.totalX]),
    byId.get("rep_current_pay_period_x").rows.map((row) => [row.repId, row.totalX])
  );
});

test("pay-period end is exclusive", () => {
  const users = [{ repId: "10", fullName: "Rep", roleId: "ROLE1", roleName: "Rep" }];
  const eligibleOrders = [
    order({ datePaid: "2026-08-16T05:59:59.999Z" }),
    order({ datePaid: "2026-08-16T06:00:00.000Z" }),
  ].map(_test.qualifyLeaderboardOrder);
  const boards = _test.buildAllBoards({
    users,
    eligibleOrders,
    repStats: new Map(),
    monthKey: "2026-08",
    payPeriodStart: new Date("2026-08-01T06:00:00.000Z"),
    payPeriodEnd: new Date("2026-08-16T06:00:00.000Z"),
    payPeriodLabel: "2026-08-01 - 2026-08-15",
  });
  const payPeriod = boards.find((item) => item.id === "rep_current_pay_period_x").payload;
  assert.equal(payPeriod.rows[0].salesCount, 1);
});
