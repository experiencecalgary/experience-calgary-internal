'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAgreementHtml, sanitizeBodyHtml, normalizeDate, LOGO_URL, WATERMARK_URL } = require('../lib/command/commandAgreementRenderer');
const { mergeFields, tokenHash, safeFilename, loadChromium } = require('../lib/command/commandAgreements');

test('Agreement body sanitizer keeps supported formatting and removes executable markup', () => {
  const html = sanitizeBodyHtml('<h2 onclick="bad()">Terms</h2><p>Hello <strong>there</strong></p><script>alert(1)</script><img src=x onerror=bad()>');
  assert.equal(html, '<h2>Terms</h2><p>Hello <strong>there</strong></p>');
});

test('merge fields are HTML escaped and do not mutate template wording', () => {
  const template = '<p>{{organizationName}} / {{contactName}} / {{email}} / {{phone}}</p>';
  const merged = mergeFields(template, {
    organizationName: '<b>Acme</b>',
    contactName: 'Jane & John',
    email: 'hello@example.com',
    phone: '587-555-0101',
  });
  assert.equal(merged, '<p>&lt;b&gt;Acme&lt;/b&gt; / Jane &amp; John / hello@example.com / 587-555-0101</p>');
  assert.equal(template, '<p>{{organizationName}} / {{contactName}} / {{email}} / {{phone}}</p>');
});

test('signing token hashes are deterministic and do not expose the source token', () => {
  const token = 'a-secure-signing-token-value';
  const hash = tokenHash(token);
  assert.equal(hash.length, 64);
  assert.equal(hash, tokenHash(token));
  assert.equal(hash.includes(token), false);
});

test('PDF filenames follow the Experience Calgary Partnership Agreement convention', () => {
  assert.equal(
    `Experience Calgary Partnership Agreement - ${safeFilename('Top Line / Home Solutions')}.pdf`,
    'Experience Calgary Partnership Agreement - Top Line  Home Solutions.pdf'
  );
});

test('Agreement PDF runtime loads the ESM Chromium default export used in production', async () => {
  const chromium = await loadChromium();
  assert.equal(typeof chromium.executablePath, 'function');
  assert.equal(Array.isArray(chromium.args), true);
  assert.ok(chromium.args.length > 0);
});

test('Agreement renderer accepts Firestore Timestamp-shaped values', () => {
  const sentAt = {
    toDate: () => new Date('2026-08-26T18:00:00Z'),
  };
  const signedAt = {
    seconds: Math.floor(new Date('2026-08-27T18:00:00Z').getTime() / 1000),
    nanoseconds: 0,
  };

  assert.equal(normalizeDate(sentAt).toISOString(), '2026-08-26T18:00:00.000Z');
  assert.equal(normalizeDate(signedAt).toISOString(), '2026-08-27T18:00:00.000Z');

  const pendingHtml = renderAgreementHtml({
    documentTitle: 'Partnership Agreement',
    organizationName: 'Example Organization',
    contactName: 'Jane Smith',
    email: 'jane@example.com',
    phone: '587-555-0101',
    bodyHtml: '<p>Approved terms.</p>',
    sentAt,
    status: 'pending',
  });
  assert.match(pendingHtml, /August 26, 2026/);
  assert.match(pendingHtml, /Pending Signature/);

  const signedHtml = renderAgreementHtml({
    documentTitle: 'Partnership Agreement',
    organizationName: 'Example Organization',
    contactName: 'Jane Smith',
    email: 'jane@example.com',
    phone: '587-555-0101',
    bodyHtml: '<p>Approved terms.</p>',
    sentAt,
    status: 'signed',
    signerName: 'Jane Smith',
    signedAt,
  });
  assert.match(signedHtml, /August 27, 2026/);
  assert.match(signedHtml, /Jane Smith/);
});

test('Agreement renderer safely falls back instead of throwing on malformed stored dates', () => {
  assert.doesNotThrow(() => renderAgreementHtml({
    documentTitle: 'Partnership Agreement',
    organizationName: 'Example Organization',
    contactName: 'Jane Smith',
    email: 'jane@example.com',
    phone: '587-555-0101',
    bodyHtml: '<p>Approved terms.</p>',
    sentAt: { unexpected: true },
    status: 'pending',
  }));
});

test('canonical HTML renderer matches the approved 860px preview design system', () => {
  const html = renderAgreementHtml({
    documentTitle: 'Partnership Agreement',
    organizationName: 'Example Organization',
    contactName: 'Jane Smith',
    email: 'jane@example.com',
    phone: '587-555-0101',
    senderName: 'Monty',
    bodyHtml: '<p>Approved terms.</p>',
    status: 'signed',
    signerName: 'Jane Smith',
    signedAt: new Date('2026-08-26T18:00:00Z'),
  });
  assert.match(html, /width:min\(860px,100%\)/);
  assert.match(html, /min-height:108px/);
  assert.match(html, /padding:18px 42px/);
  assert.match(html, /width:320px;height:320px;left:-90px;top:-92px/);
  assert.match(html, /padding:44px 52px 40px/);
  assert.match(html, /font-size:32px/);
  assert.ok(html.includes(LOGO_URL));
  assert.ok(html.includes(WATERMARK_URL));
  assert.match(html, /Expera Group Inc\./);
  assert.match(html, /curator@experiencecalgary\.ca/);
  assert.match(html, /587-897-8521/);
  assert.match(html, /Agreement &amp; Acceptance/);
  assert.match(html, /Jane Smith/);
});
