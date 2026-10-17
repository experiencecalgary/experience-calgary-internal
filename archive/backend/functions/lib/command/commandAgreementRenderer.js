'use strict';

const LOGO_URL = 'https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/exeperience-tjv0r4/assets/9nqc7tz7uqmp/Circle_No_Shine_Small.png';
const WATERMARK_URL = 'https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/exeperience-tjv0r4/assets/60jqwc3rnf0e/EC_Icon_Quarter_AppGood.webp';
const ADMIN_EMAIL = 'curator@experiencecalgary.ca';
const ADMIN_PHONE = '587-897-8521';
const COMPANY_NAME = 'Expera Group Inc.';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

function sanitizeBodyHtml(value) {
  const raw = String(value ?? '');
  const withoutDangerous = raw
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button)[^>]*\/?>/gi, '');
  return withoutDangerous.replace(/<\/?([a-z0-9]+)(?:\s[^>]*)?>/gi, (match, tag) => {
    const name = String(tag).toLowerCase();
    const allowed = new Set(['p','br','strong','b','em','i','u','ul','ol','li','h2','h3','blockquote']);
    if (!allowed.has(name)) return '';
    return /^<\s*\//.test(match) ? `</${name}>` : (name === 'br' ? '<br>' : `<${name}>`);
  });
}

function normalizeDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date() : value;
  }
  if (value && typeof value.toDate === 'function') {
    try {
      const converted = value.toDate();
      if (converted instanceof Date && !Number.isNaN(converted.getTime())) return converted;
    } catch (_) {
      // Continue through the safe fallbacks below.
    }
  }
  const seconds = Number(value?.seconds ?? value?._seconds);
  const nanoseconds = Number(value?.nanoseconds ?? value?._nanoseconds ?? 0);
  if (Number.isFinite(seconds)) {
    const converted = new Date((seconds * 1000) + Math.floor((Number.isFinite(nanoseconds) ? nanoseconds : 0) / 1e6));
    if (!Number.isNaN(converted.getTime())) return converted;
  }
  const converted = new Date(value ?? Date.now());
  return Number.isNaN(converted.getTime()) ? new Date() : converted;
}

function formatDate(value) {
  const d = normalizeDate(value);
  return new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'long', day:'numeric', timeZone:'America/Edmonton' }).format(d);
}

function renderAgreementHtml(data = {}) {
  const signed = data.status === 'signed';
  const org = esc(data.organizationName || 'No Organization');
  const contact = esc(data.contactName || '');
  const email = esc(data.email || '');
  const phone = esc(data.phone || '');
  const title = esc(data.documentTitle || 'Experience Calgary Partnership Agreement');
  const sender = esc(data.senderName || 'Experience Calgary');
  const body = sanitizeBodyHtml(data.bodyHtml || '');
  const documentDate = esc(formatDate(data.documentDate || data.sentAt || Date.now()));
  const signedDate = signed ? esc(formatDate(data.signedAt || Date.now())) : 'Pending Signature';
  const signerName = signed ? esc(data.signerName || data.contactName || '') : 'Pending Signature';
  const checked = signed ? '✓' : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  :root{--black:#050505;--gold:#c9a24f;--gold-light:#ffe7a8;--gold-dark:#6e4c16;--ink:#151515;--paper:#fbfaf7}
  *{box-sizing:border-box}html,body{margin:0;padding:0;background:#171819;color:var(--ink);font-family:Arial,Helvetica,sans-serif}body{padding:16px}.document{width:min(860px,100%);margin:0 auto;background:var(--paper);box-shadow:0 18px 55px rgba(0,0,0,.22);overflow:hidden}.header{min-height:108px;background:linear-gradient(115deg,#020202 0%,#101112 58%,#050505 100%);color:#fff;position:relative;padding:18px 42px;border-bottom:2px solid var(--gold-dark);overflow:hidden}.brand-row{display:flex;align-items:center;justify-content:space-between;gap:24px;position:relative;z-index:2}.brand{display:flex;align-items:center;gap:15px}.brand img{width:52px;height:52px;object-fit:contain}.brand-name{font-size:11px;font-weight:800;letter-spacing:2.8px;text-transform:uppercase;color:var(--gold-light)}.brand-sub{margin-top:5px;font-size:9px;letter-spacing:1.9px;text-transform:uppercase;color:#a8aaad}.doc-meta{text-align:right}.doc-meta .label{font-size:8px;letter-spacing:1.8px;color:#9f9fa1;text-transform:uppercase}.doc-meta .value{margin-top:6px;font-size:10px;letter-spacing:1px;color:#f0dc91}.hero{padding:44px 52px 40px;position:relative}.watermark{position:absolute;width:320px;height:320px;left:-90px;top:-92px;object-fit:contain;opacity:.07}.eyebrow{position:relative;z-index:2;color:var(--gold-dark);font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:11px}h1{position:relative;z-index:2;margin:0;max-width:680px;font-size:32px;line-height:1.06;letter-spacing:-.8px;font-weight:800;color:#0a0a0b}.hero-line{position:relative;z-index:2;margin-top:22px;width:100%;height:1px;background:#d8c27c}.content{padding:0 52px 40px}.prepared{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;margin-bottom:30px}.panel{background:rgba(255,255,255,.75);border:1px solid #e6e0d2;border-radius:12px;padding:18px}.panel-label,.section-label{font-size:8px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--gold-dark);margin-bottom:9px}.client-name{font-size:16px;font-weight:700;margin-bottom:6px}.client-detail{font-size:11px;line-height:1.4;color:#57575a;margin-bottom:2px}.agreement-body{font-size:13px;line-height:1.65;color:#343438}.agreement-body h2,.agreement-body h3{color:#171717}.agreement-body p{margin:0 0 14px}.agreement-body li{margin-bottom:6px}.acceptance{margin-top:34px;border:1px solid #c9b66e;border-radius:13px;overflow:hidden;background:#fff}.acceptance-head{background:linear-gradient(105deg,#050505,#111112);color:#fff;padding:15px 18px;display:flex;justify-content:space-between}.acceptance-head strong{color:var(--gold-light);letter-spacing:1.8px;text-transform:uppercase;font-size:9px}.acceptance-head span{font-size:8px;color:#929295;letter-spacing:1.4px}.acceptance-body{padding:20px}.agree{display:flex;gap:10px;align-items:flex-start;margin-bottom:24px;font-size:11px;line-height:1.7}.checkbox{flex:0 0 20px;width:20px;height:20px;border:1.5px solid var(--gold-dark);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--gold-dark);font-weight:900}.signature-grid{display:grid;grid-template-columns:1.3fr .7fr;gap:24px}.sig-label{font-size:8px;text-transform:uppercase;letter-spacing:1.8px;color:#88888b;margin-bottom:8px}.sig-value{font-family:Georgia,serif;font-style:italic;font-size:22px;padding-bottom:8px;border-bottom:1px solid #b9b4a8}.date-value{font-size:12px;font-weight:650;padding:7px 0 11px;border-bottom:1px solid #b9b4a8}.footer{background:linear-gradient(110deg,#020202,#0e0f10 62%,#050505);color:#fff;border-top:2px solid var(--gold-dark);padding:20px 42px;display:flex;align-items:center;justify-content:space-between;gap:24px}.footer-brand{display:flex;align-items:center;gap:11px}.footer img{width:36px;height:36px}.footer-company{font-size:10px;font-weight:700;letter-spacing:1.2px;color:#f0e3b6}.footer-tag{font-size:8px;margin-top:4px;letter-spacing:1.4px;text-transform:uppercase;color:#77777a}.contact{text-align:right;font-size:9px;line-height:1.5;color:#b8b8ba}.contact strong{color:var(--gold-light)}@page{size:A4;margin:0}@media print{html,body{background:#fff;padding:0}.document{width:210mm;min-height:297mm;box-shadow:none}.header,.acceptance-head,.footer{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><main class="document"><header class="header"><div class="brand-row"><div class="brand"><img src="${LOGO_URL}"><div><div class="brand-name">Experience Calgary</div><div class="brand-sub">Digital Agreement System</div></div></div><div class="doc-meta"><div class="label">Document Date</div><div class="value">${documentDate}</div></div></div></header><section class="hero"><img class="watermark" src="${WATERMARK_URL}"><div class="eyebrow">Experience Calgary / Agreement</div><h1>${title}</h1><div class="hero-line"></div></section><section class="content"><div class="prepared"><div class="panel"><div class="panel-label">Prepared For</div><div class="client-name">${org}</div><div class="client-detail">Authorized Contact: ${contact}</div><div class="client-detail">${email}</div><div class="client-detail">${phone}</div></div><div class="panel"><div class="panel-label">Prepared By</div><div class="client-name">Experience Calgary</div><div class="client-detail">${COMPANY_NAME}</div><div class="client-detail">${ADMIN_EMAIL}</div><div class="client-detail">${ADMIN_PHONE}</div><div class="client-detail">Sender: ${sender}</div></div></div><div class="section-label">Agreement</div><div class="agreement-body">${body}</div><section class="acceptance"><div class="acceptance-head"><strong>Agreement &amp; Acceptance</strong><span>Digital Signature</span></div><div class="acceptance-body"><div class="agree"><div class="checkbox">${checked}</div><div>I confirm that I have reviewed this document and agree to the terms contained in this agreement.</div></div><div class="signature-grid"><div><div class="sig-label">Signed By</div><div class="sig-value">${signerName}</div></div><div><div class="sig-label">Signed</div><div class="date-value">${signedDate}</div></div></div></div></section></section><footer class="footer"><div class="footer-brand"><img src="${LOGO_URL}"><div><div class="footer-company">EXPERIENCE CALGARY</div><div class="footer-tag">Curated Experiences · Elevated Calgary</div></div></div><div class="contact"><strong>${COMPANY_NAME}</strong><br>${ADMIN_EMAIL} &nbsp;·&nbsp; ${ADMIN_PHONE}</div></footer></main></body></html>`;
}

module.exports = { renderAgreementHtml, sanitizeBodyHtml, normalizeDate, LOGO_URL, WATERMARK_URL, ADMIN_EMAIL, ADMIN_PHONE, COMPANY_NAME };
