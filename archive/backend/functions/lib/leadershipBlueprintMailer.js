"use strict";

const nodemailer = require("nodemailer");

const CURATOR_EMAIL = "curator@experiencecalgary.ca";
const LOGO_URL = "https://experiencecalgary.ca/wp-content/uploads/2026/05/Circle-No-Shine-Large-1000.png";

const SECTION_META = [
  ["leadershipStandard", "01", "Leadership Standard"],
  ["weeklyRhythm", "02", "Weekly Operating Rhythm"],
  ["channelPlan", "03", "Sales Channel Plan"],
  ["fieldOperations", "04", "Weekly Plans & Field Operations"],
  ["developmentCamp", "05", "Six-Week Development Camp"],
  ["teamMeetings", "06", "Team Meetings & Training"],
  ["customerQuality", "07", "Customer Experience & Quality"],
  ["teamStandards", "08", "Standards, Goals & Recognition"],
  ["teamGrowth", "09", "Team Growth & Leadership Pipeline"],
];

const LABELS = {
  leaderDescription: "The leader I intend to become",
  qualities: "Leadership qualities that matter most",
  personalStandards: "Standards I will personally model",
  teamExpectation: "What my team can always expect",
  excellingReps: "How I will develop excelling reps",
  developingReps: "How I will support developing reps",
  directorSupport: "How I will use Director support",
  finalStatement: "Final Leadership Statement",
  mondayOrientation: "Monday - Orientation & Weekly Launch",
  tuesdayTraining: "Tuesday - Experiences & Sales Training",
  thursdayTraining: "Thursday - Channel & Team Growth Training",
  endOfDayMethod: "End-of-day method",
  endOfDayTime: "End-of-day time",
  dailySubmission: "Daily reporting standard",
  startingView: "Starting channel perspective",
  expansionIdeas: "Channel expansion ideas",
  outsideExperience: "Using a rep's outside channel experience",
  openingChannel: "Opening channel",
  supportingChannel: "Supporting channel",
  expansionChannel: "Expansion channel",
  resources: "Resources required",
  testDate: "First test date",
  successMeasure: "Success measurement",
  weeklyPlanTime: "Weekly Plan build time",
  weeklyPlanProcess: "Weekly Plan process",
  personalTargetMethod: "Personal target method",
  teamMeetingIntegration: "Meetings within the Weekly Plan",
  territoryMethod: "Territory assignment method",
  warmupResources: "EC warm-up & Meta support",
  phoneLeadProcess: "Phone-sales lead process",
  otherResourceMethod: "Other channel resources",
  trainingProgression: "Field-development progression",
  releaseStandard: "Independent-release standard",
  releaseApprover: "Release approval",
  reviewProcess: "Weekly Development Camp review",
  finalStandard: "Final operating standard",
  locationTypes: "Team meeting location types",
  locationConfirmation: "Location confirmation process",
  meetingTime: "Opening meeting time",
  trainingTopics: "Core training topics",
  backupLeader: "Backup meeting leader",
  finalPurpose: "Final meeting purpose",
  customerFeeling: "How every customer should feel",
  mustExplain: "What every rep must explain",
  neverAcceptable: "What is never acceptable",
  repEscalation: "Rep-to-leader escalation",
  leaderCustomerContact: "When the leader contacts customers",
  directorEscalation: "Leader-to-Director escalation",
  refundReview: "Refund review rhythm",
  qualityCoaching: "Refund and quality coaching",
  finalPromise: "Customer Experience promise",
  timeOffNotice: "Planned time-off notice",
  emergencyProcess: "Emergency time-off process",
  personalGoalProcess: "Career Meeting to weekly goals",
  goalReview: "Personal goal review",
  recognitionApproach: "Recognition approach",
  funMeetingRhythm: "Team Fun Meeting rhythm",
  onboardingCapacity: "New-rep onboarding capacity",
  campCapacity: "Development Camp capacity",
  independentCapacity: "Independent team capacity",
  newStartsPerWeek: "Ideal new starts per week",
  maxMondayStarts: "Maximum Monday orientation size",
  growth30: "30-day active-team target",
  growth60: "60-day active-team target",
  growth90: "90-day active-team target",
  accelerateWhen: "Recruiting acceleration signals",
  slowWhen: "Recruiting slowdown signals",
  finalInterviewAvailability: "Final interview availability",
  futureLeaderSignals: "Future Program Director signals",
  leadershipDevelopment: "Leadership-development process",
  firstPdTarget: "First Program Director development target",
};

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readSecret(secretOrString) {
  if (!secretOrString) return "";
  if (typeof secretOrString === "string") return secretOrString;
  if (typeof secretOrString.value === "function") return secretOrString.value();
  return "";
}

function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return clean(value) !== "";
}

function formatDate(value) {
  if (!value) return "Not set";
  const date = value.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatTime(value) {
  const text = clean(value);
  if (!/^\d{2}:\d{2}$/.test(text)) return text || "-";
  const [hour, minute] = text.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function textRow(label, value) {
  if (!present(value)) return "";
  return `
    <tr>
      <td style="width:31%;padding:13px 16px;border-top:1px solid #e7e3dc;color:#766b5c;font-size:11px;line-height:1.45;text-transform:uppercase;letter-spacing:.07em;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:13px 16px;border-top:1px solid #e7e3dc;color:#17191c;font-size:14px;line-height:1.65;vertical-align:top;white-space:pre-line;">${escapeHtml(value)}</td>
    </tr>`;
}

function detailTable(rows) {
  const content = rows.filter(Boolean).join("");
  if (!content) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e7e3dc;background:#ffffff;">${content}</table>`;
}

function renderDays(days) {
  if (!Array.isArray(days) || !days.length) return "";
  const rows = days.filter(day => day && day.active !== false).map(day => `
    <tr>
      <td style="padding:11px 10px;border-top:1px solid #e7e3dc;font-weight:600;color:#17191c;">${escapeHtml(day.day)}</td>
      <td style="padding:11px 10px;border-top:1px solid #e7e3dc;color:#575b61;">${escapeHtml(day.purpose)}</td>
      <td style="padding:11px 10px;border-top:1px solid #e7e3dc;color:#575b61;white-space:nowrap;">${escapeHtml(formatTime(day.leadershipStart))}</td>
      <td style="padding:11px 10px;border-top:1px solid #e7e3dc;color:#575b61;white-space:nowrap;">${escapeHtml(formatTime(day.teamStart))}</td>
      <td style="padding:11px 10px;border-top:1px solid #e7e3dc;color:#575b61;white-space:nowrap;">${escapeHtml(formatTime(day.teamFinish))}</td>
    </tr>`).join("");
  return `
    <div style="margin:0 0 18px;overflow-x:auto;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e7e3dc;background:#fff;font-size:12px;">
        <tr style="background:#f4f1eb;color:#75654b;text-transform:uppercase;letter-spacing:.06em;font-size:9px;"><th align="left" style="padding:10px;">Day</th><th align="left" style="padding:10px;">Purpose</th><th align="left" style="padding:10px;">Leader</th><th align="left" style="padding:10px;">Team</th><th align="left" style="padding:10px;">Finish</th></tr>${rows}
      </table>
    </div>`;
}

function renderChannels(channels) {
  if (!Array.isArray(channels)) return "";
  const valid = channels.filter(channel => clean(channel?.name));
  if (!valid.length) return "";
  return detailTable(valid.map(channel => textRow(
    `${channel.name} - ${channel.confidence || "Confidence not set"}`,
    [channel.strength, channel.newRepApproach].filter(present).join("\n")
  )));
}

function renderWeeks(weeks) {
  if (!Array.isArray(weeks)) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e7e3dc;background:#fff;font-size:12px;margin-bottom:18px;">
    <tr style="background:#f4f1eb;color:#75654b;text-transform:uppercase;letter-spacing:.06em;font-size:9px;"><th align="left" style="padding:10px;">Week</th><th align="left" style="padding:10px;">Learning Focus</th><th align="left" style="padding:10px;">Production</th><th align="left" style="padding:10px;">Field Stage</th><th align="left" style="padding:10px;">Coaching</th></tr>
    ${weeks.map(week => `<tr><td style="padding:10px;border-top:1px solid #e7e3dc;font-weight:600;">${escapeHtml(week.week)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${escapeHtml(week.focus)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${escapeHtml(week.production)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${escapeHtml(week.fieldStage)}</td><td style="padding:10px;border-top:1px solid #e7e3dc;">${escapeHtml(week.coaching)}</td></tr>`).join("")}
  </table>`;
}

function renderMilestones(milestones) {
  if (!Array.isArray(milestones)) return "";
  return detailTable(milestones.map(item => textRow(`Target Week ${item.targetWeek || "-"}`, item.name)));
}

function renderAgendas(agendas) {
  if (!Array.isArray(agendas)) return "";
  return detailTable(agendas.map(item => textRow(`${item.day} opening agenda`, item.agenda)));
}

function renderStandards(standards) {
  if (!standards || typeof standards !== "object") return "";
  return detailTable(Object.entries(standards).map(([name, item]) => textRow(
    name,
    `Expectation: ${clean(item?.expectation) || "Not set"}\nIf missed: ${clean(item?.response) || "Not set"}`
  )));
}

function renderGeneric(section, excluded = []) {
  return detailTable(Object.entries(section || {}).filter(([key, value]) =>
    !excluded.includes(key) && !Array.isArray(value) && !(value && typeof value === "object") && present(value)
  ).map(([key, value]) => textRow(LABELS[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()), value)));
}

function renderSection(key, section) {
  if (!section || typeof section !== "object") return "";
  let special = "";
  if (key === "weeklyRhythm") special = renderDays(section.days);
  if (key === "channelPlan") special = renderChannels(section.channels);
  if (key === "developmentCamp") special = renderWeeks(section.weeks) + renderMilestones(section.milestones);
  if (key === "teamMeetings") special = renderAgendas(section.agendas);
  if (key === "teamStandards") special = renderStandards(section.standards);
  const excluded = ["days", "channels", "weeks", "milestones", "agendas", "standards"];
  return special + renderGeneric(section, excluded);
}

function implementationCards(implementation) {
  const values = [
    ["Implementation Begins", formatDate(implementation?.firstImplementationDate)],
    ["First Orientation", formatDate(implementation?.firstOrientationDate)],
    ["Director Review", formatDate(implementation?.firstDirectorReviewDate)],
    ["First Priority", implementation?.firstPriority || "Not set"],
  ];
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:8px;margin:0 -8px 26px;">
    <tr>${values.map(([label, value]) => `<td width="25%" valign="top" style="background:#f4f1eb;border:1px solid #e3ded4;padding:15px;"><div style="font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#937344;margin-bottom:7px;">${escapeHtml(label)}</div><div style="font-size:13px;line-height:1.45;font-weight:600;color:#17191c;">${escapeHtml(value)}</div></td>`).join("")}</tr>
  </table>`;
}

function buildLeadershipBlueprintEmail({ blueprint, recipientType }) {
  const name = clean(blueprint.ownerName) || "Experience Calgary Leader";
  const sections = blueprint.sections || {};
  const sectionHtml = SECTION_META.map(([key, number, title]) => `
    <div style="padding:30px 0 8px;">
      <div style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#a57f45;margin-bottom:6px;">${number} / 09</div>
      <h2 style="margin:0 0 16px;font-size:22px;line-height:1.25;font-weight:500;letter-spacing:-.02em;color:#111317;">${escapeHtml(title)}</h2>
      ${renderSection(key, sections[key]) || '<p style="color:#777;font-size:13px;">Completed.</p>'}
    </div>`).join("");
  const intro = recipientType === "curator"
    ? `${name} has completed and submitted their Leadership Blueprint. The complete operating plan is recorded below for review.`
    : `Your Leadership Blueprint is complete. This is the operating plan you built for how you will lead, develop and grow your Experience Calgary team.`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#e9e7e2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17191c;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#e9e7e2;"><tr><td align="center" style="padding:30px 12px;">
      <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="width:100%;max-width:680px;background:#ffffff;border-collapse:collapse;box-shadow:0 18px 55px rgba(15,16,18,.12);">
        <tr><td style="background:#0d0f12;padding:38px 42px 40px;border-bottom:3px solid #a98249;">
          <table role="presentation" width="100%"><tr><td valign="middle"><img src="${LOGO_URL}" width="54" height="54" alt="Experience Calgary" style="display:block;width:54px;height:54px;"></td><td align="right" valign="middle"><div style="font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#b99761;">Leadership Development</div><div style="font-size:11px;color:rgba(255,255,255,.58);margin-top:4px;">Blueprint · Version ${escapeHtml(blueprint.version || 1)}</div></td></tr></table>
          <div style="margin-top:42px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#b99761;">Leadership Blueprint Complete</div>
          <h1 style="margin:10px 0 12px;font-size:38px;line-height:1.05;letter-spacing:-.04em;font-weight:500;color:#ffffff;">${escapeHtml(name)}</h1>
          <p style="margin:0;max-width:540px;color:rgba(255,255,255,.68);font-size:15px;line-height:1.65;">${escapeHtml(intro)}</p>
        </td></tr>
        <tr><td style="padding:34px 42px 42px;">
          <div style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#a57f45;margin-bottom:12px;">Implementation Commitments</div>
          ${implementationCards(blueprint.implementation || {})}
          ${sectionHtml}
          <div style="margin-top:34px;padding:22px;background:#111317;color:#ffffff;border-left:3px solid #b28a4e;">
            <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#b99761;margin-bottom:7px;">Blueprint Record</div>
            <div style="font-size:13px;line-height:1.7;color:rgba(255,255,255,.76);">Blueprint ID: ${escapeHtml(blueprint.blueprintId)}<br>Completed: ${escapeHtml(formatDate(blueprint.completedAt || new Date()))}</div>
          </div>
          <p style="margin:28px 0 0;color:#777b81;font-size:11px;line-height:1.6;text-align:center;">Experience Calgary · Leadership Development<br>This email is a record of the submitted Leadership Blueprint.</p>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

async function sendLeadershipBlueprintEmail({
  to,
  recipientType,
  blueprint,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
}) {
  const user = readSecret(STAFF_MAIL_USER);
  const pass = readSecret(STAFF_MAIL_APP_PASSWORD);
  if (!user || !pass) throw new Error("Mailer secrets not configured.");
  if (!clean(to)) throw new Error("Recipient email is missing.");

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  const name = clean(blueprint.ownerName) || "Experience Calgary Leader";
  const subject = recipientType === "curator"
    ? `Leadership Blueprint Complete - ${name}`
    : "Your Experience Calgary Leadership Blueprint";

  return transporter.sendMail({
    from: `"Experience Calgary" <${user}>`,
    to: clean(to),
    replyTo: CURATOR_EMAIL,
    subject,
    html: buildLeadershipBlueprintEmail({ blueprint, recipientType }),
  });
}

module.exports = {
  CURATOR_EMAIL,
  buildLeadershipBlueprintEmail,
  sendLeadershipBlueprintEmail,
};
