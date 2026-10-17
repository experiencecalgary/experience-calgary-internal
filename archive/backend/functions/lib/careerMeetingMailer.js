"use strict";

const nodemailer = require("nodemailer");

const CURATOR_EMAIL = "curator@experiencecalgary.ca";
const LOGO_URL = "https://experiencecalgary.ca/wp-content/uploads/2026/05/Circle-No-Shine-Large-1000.png";
const SECTION_META = [
  ["foundation", "01", "Foundation"],
  ["vision", "02", "Vision"],
  ["elevation", "03", "Your Opportunity"],
  ["lifestyle", "04", "Lifestyle & Availability"],
  ["momentum", "05", "Development Camp Launch Plan"],
  ["moments", "06", "Milestones & My Why"],
];

function clean(value) { return value == null ? "" : String(value).trim(); }
function esc(value) { return clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function secret(value) { return typeof value === "string" ? value : value?.value?.() || ""; }
function label(key) { return key.replace(/([A-Z])/g, " $1").replace(/^./, char => char.toUpperCase()); }
function formatDate(value) {
  if (!value) return "Not set";
  const date = value.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", year: "numeric", month: "long", day: "numeric" }).format(date);
}

function row(name, value) {
  if (value == null || value === "" || value === false) return "";
  if (Array.isArray(value)) value = value.join(", ");
  if (typeof value === "object") return "";
  return `<tr><td style="width:31%;padding:12px 15px;border-top:1px solid #e7e3dc;color:#7a6c59;font-size:10px;text-transform:uppercase;letter-spacing:.07em;vertical-align:top;">${esc(name)}</td><td style="padding:12px 15px;border-top:1px solid #e7e3dc;color:#17191c;font-size:13px;line-height:1.6;white-space:pre-line;">${esc(value)}</td></tr>`;
}
function table(content) { return content ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e7e3dc;background:#fff;">${content}</table>` : ""; }
function simpleObject(object, exclude = []) {
  return table(Object.entries(object || {}).filter(([key]) => !exclude.includes(key)).map(([key, value]) => row(label(key), value)).join(""));
}
function foundation(section) {
  const expenses = section.expenses || {};
  const results = table([
    row("Monthly stability", `$${Number(section.monthlyNeed || 0).toLocaleString()}`),
    row("Daily stability number", `${Number(section.securityDailyX || 0).toLocaleString()} X per day`),
    row("Monthly income goal", `$${Number(section.growthIncomeGoal || 0).toLocaleString()}`),
    row("Personal goal pace", `${Number(section.personalDailyX || 0).toLocaleString()} X per day`),
    row("Producing team members", section.producingTeamMembersRequired || 0),
    row("Team member benchmark", "1,500-2,000 X per producing day"),
  ].join(""));
  return `<div style="margin-bottom:16px;">${simpleObject(expenses)}</div>${results}`;
}
function availability(section) {
  const available = [];
  Object.entries(section.availability || {}).forEach(([day, blocks]) => {
    const selected = Object.entries(blocks || {}).filter(([, active]) => active).map(([block]) => block);
    if (selected.length) available.push(`${day}: ${selected.join(", ")}`);
  });
  return table([
    row("Hard scheduling realities", section.hardConstraints),
    row("Ideal opening availability", available.join("\n")),
    row("Schedule notes", section.scheduleContext),
    row("Momentum risks", section.momentumKillers),
    row("Success conditions", section.successBuilders),
  ].join(""));
}
function schedule(section) {
  const rows = (section.firstWeekSchedule || []).filter(item => item.date || item.startTime || item.plan).map(item => `<tr><td style="padding:10px;border-top:1px solid #e7e3dc;font-weight:600;">${esc(item.day)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${esc(item.date)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${esc(`${item.startTime || "-"} to ${item.endTime || "-"}`)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${esc(item.location)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${esc(item.plan)}</td></tr>`).join("");
  const scheduleTable = rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e7e3dc;background:#fff;font-size:11px;margin-bottom:16px;"><tr style="background:#f4f1eb;color:#765f3e;text-transform:uppercase;font-size:9px;"><th align="left" style="padding:10px;">Day</th><th align="left" style="padding:10px;">Date</th><th align="left" style="padding:10px;">Time</th><th align="left" style="padding:10px;">Meet</th><th align="left" style="padding:10px;">Plan</th></tr>${rows}</table>` : "";
  return scheduleTable + table([
    row("Agency Fun Meeting", section.agencyFunMeetingDate),
    row("Monthly team experience", section.monthlyTeamExperience?.tentativePlan),
    row("Experience idea", section.monthlyTeamExperience?.favoriteExperienceIdea),
    row("Bonus target", section.bonusTargetInterest),
    row("Travel flexibility", section.travelFlexibility),
    row("Six-week commitment", section.sixWeekCommitment),
  ].join(""));
}
function milestones(section) {
  const values = section.milestones || {};
  const names = {
    presentationReady: "Sales presentation ready by",
    certificationComplete: "Certification completed by",
    fullyCoded: "Fully coded by",
    first2000XDay: "First 2,000 X day by",
    firstTeamMember: "First team member added by",
    familyExperience: "Family or friends Experience by",
    releasePlan: "Release Plan submitted by",
    campComplete: "Development Camp completed by",
    programDirectorPromotion: "Program Director promotion target",
  };
  return table(Object.entries(names).map(([key, name]) => row(name, values[key])).join("") + [
    row("Development Camp bonus", section.bonusTarget),
    row("Diamond Club month", section.diamondClubMonth),
    row("My Why", section.why),
    row("Milestone that means the most", section.definingMilestone),
    row("Why that milestone matters", section.definingReason),
  ].join(""));
}
function renderSection(key, section) {
  if (key === "foundation") return foundation(section || {});
  if (key === "lifestyle") return availability(section || {});
  if (key === "momentum") return schedule(section || {});
  if (key === "moments") return milestones(section || {});
  return simpleObject(section || {}, ["successStandards", "bonusQualificationReviewed"]);
}

function buildCareerMeetingEmail({ meeting, recipientType }) {
  const repName = clean(meeting.repName) || "Experience Calgary Rep";
  const intro = recipientType === "curator"
    ? `${repName} has completed their Experience Career Meeting. Their financial targets, first-week launch plan and Development Camp milestones are recorded below.`
    : `Your Experience Career Meeting is complete. This is the plan you built with your Program Director for your income, schedule and Development Camp launch.`;
  const sections = SECTION_META.map(([key, number, title]) => `<div style="padding:28px 0 5px;"><div style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#a57f45;margin-bottom:6px;">${number} / 06</div><h2 style="margin:0 0 15px;font-size:22px;font-weight:500;letter-spacing:-.02em;">${esc(title)}</h2>${renderSection(key, meeting.sections?.[key])}</div>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#e9e7e2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17191c;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:30px 12px;"><table role="presentation" width="680" style="width:100%;max-width:680px;background:#fff;border-collapse:collapse;box-shadow:0 18px 55px rgba(15,16,18,.12);"><tr><td style="background:#0d0f12;padding:38px 42px 40px;border-bottom:3px solid #a98249;"><table width="100%"><tr><td><img src="${LOGO_URL}" width="54" height="54" alt="Experience Calgary"></td><td align="right" style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:#b99761;">Career Development</td></tr></table><div style="margin-top:40px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#b99761;">Experience Career Meeting Complete</div><h1 style="margin:10px 0 12px;font-size:38px;line-height:1.05;letter-spacing:-.04em;font-weight:500;color:#fff;">${esc(repName)}</h1><p style="margin:0;color:rgba(255,255,255,.68);font-size:15px;line-height:1.65;">${esc(intro)}</p></td></tr><tr><td style="padding:32px 42px 42px;">${sections}<div style="margin-top:34px;padding:21px;background:#111317;color:#fff;border-left:3px solid #b28a4e;font-size:12px;line-height:1.7;"><div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#b99761;">Meeting Record</div>Meeting ID: ${esc(meeting.meetingId)}<br>Program Director: ${esc(meeting.leaderName)}<br>Completed: ${esc(formatDate(meeting.completedAt || new Date()))}</div><p style="margin:26px 0 0;text-align:center;color:#777;font-size:11px;line-height:1.6;">Experience Calgary - Career Development<br>This email is a record of the completed Experience Career Meeting.</p></td></tr></table></td></tr></table></body></html>`;
}

async function sendCareerMeetingEmail({ to, recipientType, meeting, STAFF_MAIL_USER, STAFF_MAIL_APP_PASSWORD }) {
  const user = secret(STAFF_MAIL_USER);
  const pass = secret(STAFF_MAIL_APP_PASSWORD);
  if (!user || !pass) throw new Error("Mailer secrets not configured.");
  if (!clean(to)) throw new Error("Recipient email is missing.");
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  const subject = recipientType === "curator"
    ? `Career Meeting Complete - ${clean(meeting.repName) || "Rep"}`
    : "Your Experience Calgary Career Meeting Plan";
  return transporter.sendMail({
    from: `"Experience Calgary" <${user}>`,
    to: clean(to),
    replyTo: CURATOR_EMAIL,
    subject,
    html: buildCareerMeetingEmail({ meeting, recipientType }),
  });
}

module.exports = { CURATOR_EMAIL, buildCareerMeetingEmail, sendCareerMeetingEmail };
