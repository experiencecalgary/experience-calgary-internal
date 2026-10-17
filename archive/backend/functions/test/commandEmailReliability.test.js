"use strict";

const assert = require("node:assert/strict");
const {
  cleanInboundReply,
  cleanReplyText,
} = require("../lib/commandEmail/replyBodyCleaner");
const {
  progressiveStatus,
} = require("../lib/commandEmail/receiveCommandEmailEvents");

const gmailMultiline = `Confirm


McBride

On Sun, Jul 26, 2026 at 2:04 AM Admin EC <
admin.ec@connect.experiencecalgary.ca> wrote:

> Earlier message
`;
assert.equal(cleanReplyText(gmailMultiline), "Confirm\n\n\nMcBride");

const cleaned = cleanInboundReply({
  bodyText: gmailMultiline,
  bodyHtml: "<div>Confirm<br><br>McBride</div><div>unrecognized history</div>",
  isReply: true,
});
assert.equal(cleaned.bodyText, "Confirm\n\n\nMcBride");
assert.equal(cleaned.bodyHtml, null);
assert.equal(cleaned.replyHistoryRemoved, true);
assert.equal(cleaned.rawBodyText.includes("admin.ec@connect.experiencecalgary.ca"), true);

const forwarded = `Please review this.

---------- Forwarded message ---------
From: Someone <someone@example.com>
Subject: Details
`;
assert.equal(cleanReplyText(forwarded), forwarded.trim());

assert.equal(progressiveStatus("processed", "delivered"), "delivered");
assert.equal(progressiveStatus("delivered", "processed"), "delivered");
assert.equal(progressiveStatus("opened", "delivered"), "opened");
assert.equal(progressiveStatus("opened", "clicked"), "clicked");
assert.equal(progressiveStatus("bounced", "opened"), "bounced");

console.log("Command email reliability tests passed.");
