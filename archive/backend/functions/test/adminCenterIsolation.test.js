"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Admin Center no longer exposes bypass complimentary membership creation", () => {
  const actions = source("lib/adminCenterActions.js");
  const routes = source("routes/adminCenter.js");
  assert.equal(actions.includes("createComplimentaryMembership"), false);
  assert.equal(routes.includes("createComplimentaryMembership"), false);
});

test("removal is isolated from live customer and rep onboarding paths", () => {
  const index = source("index.js");
  const reps = source("routes/reps.js");
  const lifecycle = source("lib/repLifecycle.js");
  const teamMembership = source("lib/teamRepMembership.js");

  for (const marker of [
    "registerWooCommerceRoutes(app",
    "registerRepRoutes(app",
    "registerRepLifecycleRoutes(app",
    "sendCustomerWelcomeEmail",
    "sendNewMemberNotificationEmail",
  ]) assert.equal(index.includes(marker), true, marker);

  assert.equal(reps.includes("ensureTeamRepMembership"), true);
  assert.equal(lifecycle.includes("ensureTeamRepMembership"), true);
  assert.equal(teamMembership.includes('source: "rep_onboarding"'), true);
  assert.equal(teamMembership.includes('grantType: "team_rep_vip"'), true);
  assert.equal(teamMembership.includes("wooOrderId: null"), true);
  assert.equal(teamMembership.includes("sourceWooOrderId: null"), true);
});

test("Admin Center mount receives no customer-creation dependencies", () => {
  const index = source("index.js");
  const start = index.indexOf("registerAdminCenterRoutes(app, {");
  const end = index.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start);
  const mount = index.slice(start, end);
  assert.equal(mount.includes("getOrCreateAuthUserByEmail"), false);
  assert.equal(mount.includes("upsertUserDoc"), false);
  assert.equal(mount.includes("createMembershipForOrder"), false);
  assert.equal(mount.includes("provisionMembershipEntitlements"), false);
});
