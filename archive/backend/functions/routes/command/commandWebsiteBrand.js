'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const logger = require('firebase-functions/logger');
const { declaredColors, cssImages, prepareImage } = require('./websiteBrandAssets');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');

const REGION = 'us-central1';
const LEADS = 'commandLeads';
const ORGANIZATIONS = 'commandOrganizations';
const PREVIEWS = 'commandWebsiteBrandPreviews';
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const MAX_CANDIDATES = 40;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const IMPORTER_USER_AGENT = 'ExperienceCalgaryBrandImporter/1.0';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const COMMAND_WEBSITE_BRAND_OPENAI_MODEL = defineString('COMMAND_WEBSITE_BRAND_OPENAI_MODEL', {
  default: 'gpt-5-mini',
  description: 'OpenAI vision model used to rank Organization website branding candidates.',
});

const clean = value => typeof value === 'string' ? value.trim() : '';
const refPath = value => clean(value?.path || value);
const timestamp = () => admin.firestore.Timestamp.now();
const unique = values => [...new Set(values.filter(Boolean))];

function candidateFailureCounts(failures = []) {
  const counts = {};
  for (const failure of failures) {
    const stage = clean(failure?.stage) || 'unknown';
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return counts;
}

function safeErrorDetails(error) {
  return {
    errorCode: clean(error?.code) || clean(error?.name) || 'unknown',
    errorMessage: (clean(error?.message) || 'unknown error').slice(0, 300),
  };
}

function sourceHost(value) {
  try { return new URL(value).hostname; } catch (_) { return ''; }
}

function visible(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId ?? ''));
  return data.ownerUid === uid || data.assignedToUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

function collectionPath(value, collection, field) {
  const parts = refPath(value).split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== collection) {
    throw new HttpsError('invalid-argument', `${field} must use ${collection}/{documentId}.`);
  }
  return parts.join('/');
}

function privateIp(address) {
  const value = clean(address).toLowerCase();
  if (net.isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(value) === 6) {
    return value === '::' || value === '::1' || value.startsWith('fc') ||
      value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
      value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:');
  }
  return true;
}

async function safeHttpsUrl(value) {
  let url;
  try { url = new URL(clean(value)); } catch (_) {
    throw new HttpsError('invalid-argument', 'Website must be a valid public https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new HttpsError('invalid-argument', 'Website must be a normal public https URL.');
  }
  if (net.isIP(url.hostname) || url.hostname === 'localhost' || !url.hostname.includes('.')) {
    throw new HttpsError('invalid-argument', 'Website host must be public.');
  }
  let addresses;
  try { addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }); }
  catch (_) { throw new HttpsError('failed-precondition', 'Website host could not be resolved.'); }
  if (!addresses.length || addresses.some(entry => privateIp(entry.address))) {
    throw new HttpsError('permission-denied', 'Private or reserved website addresses are not allowed.');
  }
  url.hash = '';
  return url;
}

async function safeFetch(value, { maxBytes, accept, browserProfile = false, referer = '' }) {
  let current = await safeHttpsUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual', signal: controller.signal,
        headers: {
          'user-agent': browserProfile ? BROWSER_USER_AGENT : IMPORTER_USER_AGENT,
          accept,
          ...(browserProfile ? {
            'accept-language': 'en-CA,en;q=0.9,en-US;q=0.8',
            'cache-control': 'no-cache',
            pragma: 'no-cache',
          } : {}),
          ...(clean(referer) ? { referer: clean(referer) } : {}),
        },
      });
    } catch (error) {
      throw new HttpsError('unavailable', `Website request failed: ${clean(error.message) || 'unavailable'}`);
    } finally { clearTimeout(timeoutId); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === MAX_REDIRECTS) throw new HttpsError('failed-precondition', 'Website redirected too many times.');
      current = await safeHttpsUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new HttpsError('failed-precondition', `Website returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > maxBytes) throw new HttpsError('resource-exhausted', 'Website resource is too large.');
    const chunks = []; let received = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new HttpsError('unavailable', 'Website returned no readable content.');
    const bodyTimeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        received += chunk.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new HttpsError('resource-exhausted', 'Website resource is too large.');
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('unavailable', `Website response could not be read: ${clean(error.message) || 'unavailable'}`);
    } finally { clearTimeout(bodyTimeoutId); }
    const buffer = Buffer.concat(chunks, received);
    return { url: current.toString(), response, buffer };
  }
  throw new HttpsError('failed-precondition', 'Website request could not be completed.');
}

function decodeHtml(value) {
  return clean(value).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function absoluteUrl(value, base) {
  if (!clean(value)) return '';
  try {
    const url = new URL(decodeHtml(value), base);
    if (url.protocol !== 'https:' || url.username || url.password ||
        /(?:^|\.)(?:facebook|instagram|youtube|youtu\.be|tiktok|pinterest|twitter|x)\.com$/i.test(url.hostname)) return '';
    url.hash = '';
    return url.toString();
  } catch (_) { return ''; }
}

function srcsetUrl(value) {
  return clean(value).split(',').map(entry => {
    const [url, descriptor = '1x'] = entry.trim().split(/\s+/);
    return { url, size: parseFloat(descriptor) || 1 };
  }).filter(row => row.url).sort((a, b) => b.size - a.size)[0]?.url || '';
}

async function wordpressHomepageHtml(pageUrl) {
  const base = new URL(pageUrl);
  const requestJson = async path => {
    const response = await safeFetch(new URL(path, base).toString(), {
      maxBytes: MAX_HTML_BYTES,
      accept: 'application/json',
      browserProfile: true,
      referer: base.toString(),
    });
    const contentType = clean(response.response.headers.get('content-type')).toLowerCase();
    if (!contentType.includes('json')) return null;
    try { return JSON.parse(response.buffer.toString('utf8')); } catch (_) { return null; }
  };
  const pages = await requestJson('/wp-json/wp/v2/pages?per_page=100&_fields=link,content');
  if (!Array.isArray(pages)) return '';
  const normalizedPath = value => {
    try {
      const path = new URL(value, base).pathname.replace(/\/+$/, '');
      return path || '/';
    } catch (_) { return ''; }
  };
  const targetPath = normalizedPath(base);
  const selected = pages.find(row => normalizedPath(row?.link) === targetPath) ||
    pages.find(row => normalizedPath(row?.link) === '/');
  let html = clean(selected?.content?.rendered);
  // Theme/header logos often do not appear in a WordPress page's rendered content.
  // Add only media explicitly matched by WordPress's bounded "logo" search.
  try {
    const media = await requestJson('/wp-json/wp/v2/media?search=logo&per_page=20&_fields=source_url,slug,alt_text,media_details');
    if (Array.isArray(media)) {
      for (const item of media) {
        const url = clean(item?.source_url).replace(/"/g, '&quot;');
        if (!url) continue;
        const title = clean(item?.alt_text || item?.slug).replace(/"/g, '&quot;');
        const width = Number(item?.media_details?.width) || 0;
        const height = Number(item?.media_details?.height) || 0;
        html += `<img src="${url}" title="${title}" width="${width}" height="${height}">`;
      }
    }
  } catch (_) { /* Homepage content remains useful when media search is unavailable. */ }
  return html;
}

function imageCandidates(html, base) {
  const rows = [];
  const add = (raw, kind, text = '', score = 0) => {
    const url = absoluteUrl(raw, base);
    if (!url || /(?:sprite|tracking|pixel|spacer|badge|map|avatar|emoji)/i.test(`${url} ${text}`)) return;
    rows.push({ url, kind, text: clean(text).slice(0, 180), heuristicScore: score });
  };
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    const key = clean(a.property || a.name).toLowerCase();
    if (['og:image', 'twitter:image', 'twitter:image:src'].includes(key)) add(a.content, 'metadata', key, 100);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(match[0]); const rel = clean(a.rel).toLowerCase();
    if (/icon/.test(rel)) add(a.href, 'favicon', rel, rel.includes('apple') ? 72 : 55);
  }
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    const source = srcsetUrl(a.srcset || a['data-srcset']) || a['data-original'] || a['data-src'] || a['data-lazy-src'] || a.src;
    const text = `${a.alt || ''} ${a.title || ''} ${a.class || ''} ${a.id || ''} ${source}`;
    let score = 25;
    if (/logo|brand/i.test(text)) score += 70;
    if (/hero|banner|masthead|feature/i.test(text)) score += 45;
    const width = Number(a.width) || 0; const height = Number(a.height) || 0;
    if (width >= 800 || height >= 500) score += 25;
    if ((width && width < 120) || (height && height < 80)) score -= 25;
    if (a['data-original'] && a['data-original'] !== source) add(a['data-original'], /logo|brand/i.test(text) ? 'logo' : 'image', text, score + 5);
    add(source, /logo|brand/i.test(text) ? 'logo' : /hero|banner|masthead/i.test(text) ? 'hero' : 'image', text, score);
  }
  for (const match of html.matchAll(/<source\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    add(srcsetUrl(a.srcset || a['data-srcset']), 'responsive_image', clean(a.media || a.type), 35);
  }
  for (const match of html.matchAll(/(?:background(?:-image)?\s*:\s*url\(|url\()\s*['"]?([^'"\)]+)['"]?\)/gi)) {
    add(match[1], 'css_background', '', 45);
  }
  const best = new Map();
  for (const row of rows) {
    const old = best.get(row.url);
    if (!old || row.heuristicScore > old.heuristicScore) best.set(row.url, row);
  }
  return [...best.values()].sort((a, b) => b.heuristicScore - a.heuristicScore).slice(0, MAX_CANDIDATES).map((row, index) => ({ ...row, id: `candidate_${index + 1}` }));
}

function fallbackSelection(candidates, colors) {
  const logo = candidates.find(x => x.kind === 'logo') || candidates.find(x => x.kind === 'favicon');
  const hero = candidates.find(x => x.kind === 'metadata') || candidates.find(x => x.kind === 'hero') || candidates.find(x => x.id !== logo?.id);
  const gallery = candidates.filter(x => ![logo?.id, hero?.id].includes(x.id)).slice(0, 4);
  return { logoCandidateId: logo?.id || '', heroCandidateId: hero?.id || '', galleryCandidateIds: gallery.map(x => x.id), brandColorHex: colors[0] || '', confidence: 'heuristic', warnings: [] };
}

function openAiText(response) {
  for (const item of response?.output || []) for (const content of item?.content || []) {
    if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
  }
  return '';
}

async function rankWithVision(candidates, colors, website, apiKey, model) {
  if (!clean(apiKey) || !candidates.length) return fallbackSelection(candidates, colors);
  const shortlist = candidates.slice(0, 12);
  const schema = { type: 'object', additionalProperties: false, required: ['logoCandidateId', 'heroCandidateId', 'galleryCandidateIds', 'brandColorHex', 'confidence', 'warnings'], properties: {
    logoCandidateId: { type: 'string' }, heroCandidateId: { type: 'string' }, galleryCandidateIds: { type: 'array', maxItems: 4, items: { type: 'string' } },
    brandColorHex: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, warnings: { type: 'array', items: { type: 'string' } },
  } };
  const content = [{ type: 'input_text', text: `Select the genuine business logo, strongest homepage hero, and up to four representative project/gallery images for ${website}. Reject icons, maps, badges, social embeds, team headshots, duplicates, generic stock imagery, and unreadable crops. Declared colors: ${JSON.stringify(colors)}. Return only candidate IDs provided. Use an uppercase six-digit HEX color or empty string.` }];
  for (const item of shortlist) {
    content.push({ type: 'input_text', text: `${item.id}: kind=${item.kind}; hint=${item.text}; url=${item.url}` });
    content.push({ type: 'input_image', image_url: item.url, detail: 'low' });
  }
  const controller = new AbortController(); const timeoutId = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({
      model: clean(model) || 'gpt-5-mini', store: false, max_output_tokens: 1200,
      instructions: 'You are a conservative business-brand asset curator. Never invent assets.',
      input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'website_brand_selection', strict: true, schema } },
    }) });
    if (!response.ok) throw new Error(`OpenAI ranking failed (${response.status}).`);
    const result = JSON.parse(openAiText(await response.json()));
    const allowed = new Set(shortlist.map(x => x.id));
    result.logoCandidateId = allowed.has(result.logoCandidateId) ? result.logoCandidateId : '';
    result.heroCandidateId = allowed.has(result.heroCandidateId) ? result.heroCandidateId : '';
    result.galleryCandidateIds = unique((result.galleryCandidateIds || []).filter(id => allowed.has(id))).slice(0, 4);
    result.brandColorHex = /^#[0-9A-F]{6}$/i.test(clean(result.brandColorHex)) ? clean(result.brandColorHex).toUpperCase() : '';
    return result;
  } catch (error) {
    const fallback = fallbackSelection(candidates, colors);
    fallback.warnings.push(`Vision ranking unavailable: ${clean(error.message) || 'unknown error'}`);
    return fallback;
  } finally { clearTimeout(timeoutId); }
}

async function commandContext(request) {
  const db = admin.firestore(); const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

async function leadOrganization(ctx) {
  let leadRef = null, lead = null, organizationRef = null;
  if (clean(ctx.input.leadRefPath)) {
    leadRef = ctx.db.doc(collectionPath(ctx.input.leadRefPath, LEADS, 'leadRefPath'));
    const snap = await leadRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
    lead = snap.data() || {};
    if (!visible(ctx.uid, ctx.actor.userData, lead)) throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
    organizationRef = lead.subjectOrganizationRef || lead.organizationRef || lead.connectedOrganizationRef;
  }
  if (clean(ctx.input.organizationRefPath)) {
    const explicit = ctx.db.doc(collectionPath(ctx.input.organizationRefPath, ORGANIZATIONS, 'organizationRefPath'));
    if (organizationRef && organizationRef.path !== explicit.path) throw new HttpsError('failed-precondition', 'Organization does not match the Lead.');
    if (lead && !organizationRef) throw new HttpsError('failed-precondition', 'Connect this Organization to the Lead first.');
    organizationRef = explicit;
  }
  if (!organizationRef?.get) throw new HttpsError('failed-precondition', 'Select a connected Organization.');
  const snap = await organizationRef.get();
  if (!snap.exists || organizationRef.parent.id !== ORGANIZATIONS || snap.data()?.archived === true) throw new HttpsError('not-found', 'Active Organization not found.');
  const organization = snap.data() || {};
  if (!lead && !visible(ctx.uid, ctx.actor.userData, organization)) throw new HttpsError('permission-denied', 'You do not have access to this Organization.');
  return { leadRef, lead: lead || organization, organizationRef, organization };
}
function brandFields(data) {
  return { logoUrl: clean(data.logoUrl), heroImageUrl: clean(data.heroImageUrl),
    galleryImageUrls: Array.isArray(data.galleryImageUrls) ? data.galleryImageUrls : [],
    brandColorHex: clean(data.brandColorHex), originalAssets: data.websiteBrandOriginalAssets || null };
}
async function getCommandOrganizationBrandService(request) {
  const ctx = await commandContext(request), related = await leadOrganization(ctx);
  return { ok: true, organizationRefPath: related.organizationRef.path, websiteUrl: clean(related.organization.website || related.organization.websiteUrl), brand: brandFields(related.organization) };
}
async function saveCommandOrganizationBrandService(request) {
  const ctx = await commandContext(request), related = await leadOrganization(ctx);
  const fields = ctx.input.brand || {}, updates = {};
  const bucket = admin.storage().bucket().name;
  for (const key of ['logoUrl', 'heroImageUrl']) if (Object.hasOwn(fields, key)) updates[key] = ownedStorageUrl(fields[key], bucket);
  if (Object.hasOwn(fields, 'galleryImageUrls')) {
    if (!Array.isArray(fields.galleryImageUrls) || fields.galleryImageUrls.length > 4) throw new HttpsError('invalid-argument', 'Choose up to four gallery images.');
    updates.galleryImageUrls = unique(fields.galleryImageUrls.map(url => ownedStorageUrl(url, bucket)).filter(Boolean));
  }
  if (Object.hasOwn(fields, 'brandColorHex')) {
    const color = clean(fields.brandColorHex);
    if (color && !/^#[0-9A-F]{6}$/i.test(color)) throw new HttpsError('invalid-argument', 'Use a six-digit hex colour.');
    updates.brandColorHex = color.toUpperCase();
  }
  await related.organizationRef.update({ ...updates, updatedAt: timestamp(), updatedByRef: ctx.actor.userRef });
  return { ok: true, brand: brandFields({ ...related.organization, ...updates }) };
}

async function previewCommandWebsiteBrandService(request, ai = {}) {
  const ctx = await commandContext(request); const related = await leadOrganization(ctx);
  const requestedWebsite = clean(ctx.input.websiteUrl) || clean(related.organization.website || related.organization.websiteUrl);
  let page = await safeFetch(requestedWebsite, { maxBytes: MAX_HTML_BYTES, accept: 'text/html,application/xhtml+xml' });
  let contentType = clean(page.response.headers.get('content-type')).toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new HttpsError('failed-precondition', 'Website did not return an HTML page.');
  let html = page.buffer.toString('utf8');
  const warnings = [];
  let browserProfile = false;
  const initialHadNoCandidates = !imageCandidates(html, page.url).length;
  // Some hosts return a minimal bot/interstitial document to non-browser user agents.
  // Retry only when the fast response exposes no image source at all.
  if (initialHadNoCandidates) {
    try {
      const browserPage = await safeFetch(requestedWebsite, {
        maxBytes: MAX_HTML_BYTES,
        accept: 'text/html,application/xhtml+xml',
        browserProfile: true,
      });
      const browserContentType = clean(browserPage.response.headers.get('content-type')).toLowerCase();
      if (browserContentType.includes('text/html') || browserContentType.includes('application/xhtml+xml')) {
        const browserHtml = browserPage.buffer.toString('utf8');
        if (imageCandidates(browserHtml, browserPage.url).length) {
          page = browserPage;
          html = browserHtml;
          contentType = browserContentType;
          browserProfile = true;
          logger.info('Command website brand discovery recovered with browser profile', {
            organizationId: related.organizationRef.id,
            sourceHost: sourceHost(page.url),
          });
        }
      }
    } catch (error) {
      warnings.push(`Browser-profile retry failed: ${safeErrorDetails(error).errorMessage}`);
      logger.warn('Command website brand browser-profile retry failed', {
        organizationId: related.organizationRef.id,
        sourceHost: sourceHost(requestedWebsite),
        ...safeErrorDetails(error),
      });
    }
  }
  if (initialHadNoCandidates) {
    try {
      const wordpressHtml = await wordpressHomepageHtml(page.url);
      if (imageCandidates(wordpressHtml, page.url).length) {
        html = `${html}\n${wordpressHtml}`;
        browserProfile = true;
        logger.info('Command website brand discovery recovered from WordPress content', {
          organizationId: related.organizationRef.id,
          sourceHost: sourceHost(page.url),
        });
      }
    } catch (error) {
      warnings.push(`WordPress discovery fallback failed: ${safeErrorDetails(error).errorMessage}`);
    }
  }
  const sheets = [];
  const stylesheetUrls = unique([...html.matchAll(/<link\b[^>]*>/gi)].map(match => attributes(match[0]))
    .filter(a => clean(a.rel).toLowerCase().split(/\s+/).includes('stylesheet'))
    .map(a => absoluteUrl(a.href, page.url))).slice(0, 4);
  const fetchedSheets = await Promise.allSettled(stylesheetUrls.map(url => safeFetch(url, { maxBytes: 256 * 1024, accept: 'text/css', browserProfile, referer: browserProfile ? page.url : '' })));
  for (const result of fetchedSheets) {
    if (result.status === 'fulfilled' && clean(result.value.response.headers.get('content-type')).toLowerCase().includes('text/css')) sheets.push(result.value);
    else warnings.push('A stylesheet could not be read; some colours or backgrounds may be missing.');
  }
  const rawCandidates = imageCandidates(html, page.url);
  const known = new Set(rawCandidates.map(row => row.url));
  for (const sheet of sheets) for (const url of cssImages(sheet.buffer.toString('utf8'), sheet.url)) {
    if (!known.has(url) && rawCandidates.length < MAX_CANDIDATES) {
      rawCandidates.push({ id: `candidate_${rawCandidates.length + 1}`, url, kind: 'css_background', text: 'Website background image', heuristicScore: 65 });
      known.add(url);
    }
  }
  const colors = declaredColors(html, sheets.map(sheet => sheet.buffer.toString('utf8')));
  rawCandidates.sort((a, b) => b.heuristicScore - a.heuristicScore);
  if (rawCandidates.length > 18) warnings.push('Checked the 18 highest-ranked image sources; additional sources were not imported.');
  const at = timestamp(); const previewRef = ctx.db.collection(PREVIEWS).doc();
  const expiresAt = admin.firestore.Timestamp.fromMillis(at.toMillis() + PREVIEW_TTL_MS);
  const previewRoot = `PartnerImages/${related.organizationRef.id}/website-previews/${previewRef.id}`;
  // Create a cleanup record before uploading anything, including interrupted requests.
  await previewRef.set({ status: 'preparing', expiresAt, previewStoragePrefix: `${previewRoot}/`, createdAt: at, createdByUid: ctx.uid });
  const candidates = [];
  const candidateFailures = [];
  const deadline = Date.now() + 120000;
  for (const row of rawCandidates.slice(0, 18)) {
    if (Date.now() > deadline) { warnings.push('Discovery time limit reached; remaining images were not checked.'); break; }
    let stage = 'download';
    try {
      const asset = await safeFetch(row.url, { maxBytes: MAX_IMAGE_BYTES, accept: 'image/webp,image/png,image/jpeg,image/svg+xml', browserProfile, referer: browserProfile ? page.url : '' });
      stage = 'decode';
      const prepared = await prepareImage(asset.buffer);
      const originalPath = `${previewRoot}/${row.id}.${prepared.ext}`;
      stage = 'upload-original';
      await storeImageBytes(originalPath, asset.buffer, prepared.contentType);
      stage = 'upload-preview';
      const previewUrl = await storeImageBytes(`${previewRoot}/${row.id}-preview.webp`, prepared.thumbnail, 'image/webp');
      candidates.push({ ...row, sourceUrl: asset.url, url: previewUrl, previewUrl, originalStoragePath: originalPath,
        width: prepared.width, height: prepared.height, pixelArea: prepared.width * prepared.height,
        format: prepared.ext, validated: true });
    } catch (error) {
      const failure = {
        candidateId: row.id,
        candidateKind: row.kind,
        sourceHost: sourceHost(row.url),
        stage,
        ...safeErrorDetails(error),
      };
      candidateFailures.push(failure);
      logger.warn('Command website brand candidate skipped', {
        organizationId: related.organizationRef.id,
        previewId: previewRef.id,
        ...failure,
      });
      warnings.push(`Skipped ${row.id} at ${stage}: ${failure.errorMessage}`);
    }
  }
  candidates.sort((a, b) => (b.heuristicScore + Math.log2(b.pixelArea || 1)) - (a.heuristicScore + Math.log2(a.pixelArea || 1)));

  if (!candidates.length) {
    const failureCounts = candidateFailureCounts(candidateFailures);
    logger.error('Command website brand preview produced no usable candidates', {
      organizationId: related.organizationRef.id,
      previewId: previewRef.id,
      sourceHost: sourceHost(page.url),
      discoveredCandidateCount: rawCandidates.length,
      attemptedCandidateCount: candidateFailures.length,
      failureCounts,
    });
    const summary = Object.entries(failureCounts).map(([stage, count]) => `${stage}: ${count}`).join(', ');
    throw new HttpsError(
      'failed-precondition',
      rawCandidates.length
        ? `Website images were found but could not be prepared${summary ? ` (${summary})` : ''}. Check previewCommandWebsiteBrand logs.`
        : 'No website image sources were discovered. Add assets manually instead.',
      {
        reason: rawCandidates.length ? 'candidate-processing-failed' : 'no-candidates-discovered',
        discoveredCandidateCount: rawCandidates.length,
        attemptedCandidateCount: candidateFailures.length,
        failureCounts,
      },
    );
  }
  const selection = await rankWithVision(candidates, colors, page.url, ai.apiKey, ai.model);
  selection.warnings = [...warnings, ...(selection.warnings || [])];
  if (selection.brandColorHex && !colors.includes(selection.brandColorHex)) {
    selection.brandColorHex = colors[0] || '';
    selection.warnings.push('Choose a brand colour from the detected CSS palette or enter it manually.');
  }
  await previewRef.set({ previewStoragePrefix: `${previewRoot}/`, schemaVersion: 2, status: 'preview', sourceUrl: page.url, sourceHost: new URL(page.url).hostname, extractedAt: at, expiresAt, leadRef: related.leadRef, organizationRef: related.organizationRef, candidates, declaredColors: colors, suggestedSelection: selection, ownerUid: clean(related.lead.ownerUid) || ctx.uid, assignedToUid: clean(related.lead.assignedToUid), viewerUids: related.lead.viewerUids || [ctx.uid], teamRepIds: related.lead.teamRepIds || [], createdAt: at, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid });
  return { ok: true, previewId: previewRef.id, expiresAt: expiresAt.toDate().toISOString(), sourceUrl: page.url, declaredColors: colors, warnings: selection.warnings, candidates, suggestedSelection: selection, existingBrand: { logoUrl: clean(related.organization.logoUrl), heroImageUrl: clean(related.organization.heroImageUrl), brandColorHex: clean(related.organization.brandColorHex), galleryImageUrls: Array.isArray(related.organization.galleryImageUrls) ? related.organization.galleryImageUrls : [] } };
}

function extension(contentType) {
  const value = clean(contentType).split(';')[0].toLowerCase();
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[value] || '';
}

function detectedImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function ownedStorageUrl(value, bucketName) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const firebasePrefix = `/v0/b/${bucketName}/o/`;
    const googlePrefix = `/${bucketName}/`;
    const valid = url.protocol === 'https:' && (
      (url.hostname === 'firebasestorage.googleapis.com' && url.pathname.toLowerCase().startsWith(`${firebasePrefix}PartnerImages%2F`.toLowerCase())) ||
      (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith(`${googlePrefix}PartnerImages/`))
    );
    if (!valid || decodeURIComponent(url.pathname).includes('/website-previews/')) throw new Error('not a permanent owned asset');
    return url.toString();
  } catch (_) {
    throw new HttpsError('invalid-argument', 'Manual assets must already be uploaded to this project’s Firebase Storage bucket.');
  }
}

async function storeImageBytes(path, buffer, contentType) {
  const token = crypto.randomUUID(); const bucket = admin.storage().bucket();
  await bucket.file(path).save(buffer, { resumable: false, contentType,
    metadata: { cacheControl: 'public,max-age=31536000,immutable', metadata: { firebaseStorageDownloadTokens: token } } });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function saveRemoteImage(url, destination, stagedPath = '') {
  let buffer, sourceUrl = url;
  if (stagedPath) [buffer] = await admin.storage().bucket().file(stagedPath).download();
  else {
    const image = await safeFetch(url, { maxBytes: MAX_IMAGE_BYTES, accept: 'image/webp,image/png,image/jpeg,image/svg+xml' });
    buffer = image.buffer; sourceUrl = image.url;
  }
  if (buffer.length > MAX_IMAGE_BYTES) throw new HttpsError('resource-exhausted', 'Selected image exceeds 10 MB.');
  let prepared;
  try { prepared = await prepareImage(buffer); }
  catch (error) { throw new HttpsError('failed-precondition', `Selected image cannot be decoded: ${clean(error.message)}`); }
  const path = `${destination}.${prepared.ext}`;
  const originalUrl = await storeImageBytes(path, buffer, prepared.contentType);
  const displayUrl = await storeImageBytes(`${destination}-display.webp`, prepared.display, 'image/webp');
  return { url: displayUrl, originalUrl, width: prepared.width, height: prepared.height,
    sourceUrl, requestedUrl: url, storagePath: path, contentHash: crypto.createHash('sha256').update(buffer).digest('hex') };
}

// Deletes only temporary discovery files, never committed imports or manual assets.
async function cleanupCommandWebsiteBrandPreviewsService() {
  const db = admin.firestore();
  const expired = await db.collection(PREVIEWS).where('expiresAt', '<', timestamp()).limit(50).get();
  for (const doc of expired.docs) {
    const preview = doc.data();
    const prefix = clean(preview.previewStoragePrefix);
    if (prefix && /^PartnerImages\/[^/]+\/website-previews\/[^/]+\/$/.test(prefix) && prefix.endsWith(`/${doc.id}/`)) {
      await admin.storage().bucket().deleteFiles({ prefix });
    }
    // Retain audit and idempotency data; remove the expiry from the cleanup query.
    await doc.ref.update({ expiresAt: admin.firestore.FieldValue.delete(), previewFilesCleanedAt: timestamp(),
      ...(preview.status === 'committed' ? {} : { status: 'expired' }) });
  }
}

function sourceKey(value) {
  return crypto.createHash('sha256').update(clean(value)).digest('hex').slice(0, 12);
}

// Opt-in complete selection for the new editor. Legacy selection remains supported.
// null clears a slot; {url} retains a manual/saved asset; {candidateId} imports it.
function completeSelection(value, bucket) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpsError('invalid-argument', 'finalSelection must be an object.');
  if (!Object.hasOwn(value, 'logo') || !Object.hasOwn(value, 'hero') || !Array.isArray(value.gallery) || value.gallery.length > 4 || !Object.hasOwn(value, 'brandColorHex')) {
    throw new HttpsError('invalid-argument', 'Provide logo, hero, up to four gallery slots, and brandColorHex.');
  }
  const slot = entry => {
    if (entry === null) return null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Boolean(clean(entry.url)) === Boolean(clean(entry.candidateId))) {
      throw new HttpsError('invalid-argument', 'Each image slot must contain either url or candidateId.');
    }
    return clean(entry.url) ? { url: ownedStorageUrl(entry.url, bucket) } : { candidateId: clean(entry.candidateId) };
  };
  const color = clean(value.brandColorHex).toUpperCase();
  if (color && !/^#[0-9A-F]{6}$/.test(color)) throw new HttpsError('invalid-argument', 'Use a six-digit hex colour.');
  return { logo: slot(value.logo), hero: slot(value.hero), gallery: value.gallery.map(slot).filter(Boolean), brandColorHex: color };
}

function applyCompleteSelection(final, candidateAssets, updates) {
  const resolve = slot => {
    if (!slot) return '';
    if (slot.url) return slot.url;
    if (!candidateAssets[slot.candidateId]) throw new HttpsError('failed-precondition', `Image ${slot.candidateId} was not saved.`);
    return candidateAssets[slot.candidateId];
  };
  updates.logoUrl = resolve(final.logo);
  updates.heroImageUrl = resolve(final.hero);
  updates.galleryImageUrls = unique(final.gallery.map(resolve));
  updates.brandColorHex = final.brandColorHex;
}

function assertActivePreview(preview) {
  if (preview.status !== 'preview' || !preview.expiresAt?.toMillis || preview.expiresAt.toMillis() <= Date.now()) {
    throw new HttpsError('deadline-exceeded', 'This preview expired or is not ready. Create a new preview.');
  }
}

async function commitCommandWebsiteBrandService(request) {
  const ctx = await commandContext(request); const previewId = clean(ctx.input.previewId);
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(previewId)) throw new HttpsError('invalid-argument', 'A valid previewId is required.');
  const previewRef = ctx.db.collection(PREVIEWS).doc(previewId); const snap = await previewRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Brand preview not found.');
  const preview = snap.data() || {};
  if (!visible(ctx.uid, ctx.actor.userData, preview)) throw new HttpsError('permission-denied', 'You do not have access to this preview.');
  await leadOrganization({ ...ctx, input: { leadRefPath: refPath(preview.leadRef), organizationRefPath: refPath(preview.organizationRef) } });
  if (clean(preview.status) === 'committed') return { ok: true, duplicate: true, organizationRefPath: refPath(preview.organizationRef), savedBrand: preview.savedBrand || {} };
  assertActivePreview(preview);
  const candidateById = new Map((preview.candidates || []).map(row => [row.id, row]));
  const bucketName = admin.storage().bucket().name;
  const final = Object.hasOwn(ctx.input, 'finalSelection') ? completeSelection(ctx.input.finalSelection, bucketName) : null;
  const selection = final ? {
    logoCandidateId: final.logo?.candidateId || '', heroCandidateId: final.hero?.candidateId || '',
    galleryCandidateIds: final.gallery.map(slot => slot.candidateId).filter(Boolean), brandColorHex: final.brandColorHex,
    manualLogoUrl: final.logo?.url || '', manualHeroImageUrl: final.hero?.url || '',
  } : ctx.input.selection && typeof ctx.input.selection === 'object' ? ctx.input.selection : preview.suggestedSelection || {};
  const manualLogo = ownedStorageUrl(selection.manualLogoUrl, bucketName);
  const manualHero = ownedStorageUrl(selection.manualHeroImageUrl, bucketName);
  const manualGallery = unique((Array.isArray(selection.manualGalleryImageUrls) ? selection.manualGalleryImageUrls : []).map(url => ownedStorageUrl(url, bucketName))).slice(0, 4);
  const chosen = id => {
    if (!clean(id)) return '';
    const candidate = candidateById.get(clean(id));
    if (!candidate) throw new HttpsError('invalid-argument', `Unknown image candidate: ${clean(id)}`);
    return candidate.sourceUrl || candidate.url;
  };
  const saveChosen = async (url, destination, slot) => {
    const candidate = [...candidateById.values()].find(row => (row.sourceUrl || row.url) === url);
    const stagedPath = clean(candidate?.originalStoragePath);
    if (stagedPath && !stagedPath.startsWith(`PartnerImages/${preview.organizationRef.id}/website-previews/${previewId}/`)) {
      throw new HttpsError('failed-precondition', 'Invalid staged image path. Fetch website assets again.');
    }
    try { return await saveRemoteImage(url, destination, stagedPath); }
    catch (error) { throw new HttpsError('failed-precondition', `${slot} could not be saved: ${clean(error.message)}`, { slot, candidateId: candidate?.id || '' }); }
  };
  const logoSource = manualLogo ? '' : chosen(selection.logoCandidateId);
  const heroSource = manualHero ? '' : chosen(selection.heroCandidateId);
  const gallerySources = manualGallery.length ? [] : unique((Array.isArray(selection.galleryCandidateIds) ? selection.galleryCandidateIds : []).map(chosen)).filter(Boolean).slice(0, 4);
  if (!final && !manualLogo && !manualHero && !manualGallery.length && !logoSource && !heroSource && !gallerySources.length) throw new HttpsError('invalid-argument', 'Choose at least one website asset to save.');
  const root = `PartnerImages/${preview.organizationRef.id}/website-imports/${previewRef.id}/${crypto.randomUUID()}`;
  // Decode one high-resolution source at a time to stay within function memory.
  const logo = logoSource ? await saveChosen(logoSource, `${root}/logo-${sourceKey(logoSource)}`, 'Logo') : null;
  const hero = heroSource ? await saveChosen(heroSource, `${root}/hero-${sourceKey(heroSource)}`, 'Hero') : null;
  const gallery = [];
  for (const [index, url] of gallerySources.entries()) {
    gallery.push(await saveChosen(url, `${root}/gallery-${index + 1}-${sourceKey(url)}`, `Gallery ${index + 1}`));
  }
  const usedHashes = new Set([logo?.contentHash, hero?.contentHash].filter(Boolean));
  const approvedGallery = gallery.filter(asset => {
    if (!asset?.contentHash || usedHashes.has(asset.contentHash)) return false;
    usedHashes.add(asset.contentHash);
    return true;
  });
  const color = /^#[0-9A-F]{6}$/i.test(clean(selection.brandColorHex)) ? clean(selection.brandColorHex).toUpperCase() : '';
  const at = timestamp(); const updates = { websiteBrandSourceUrl: clean(preview.sourceUrl), websiteBrandExtractedAt: preview.extractedAt || at, websiteBrandApprovedAt: at, websiteBrandApprovedByRef: ctx.actor.userRef, updatedAt: at, updatedByRef: ctx.actor.userRef };
  if (manualLogo || logo) updates.logoUrl = manualLogo || logo.url;
  if (manualHero || hero) updates.heroImageUrl = manualHero || hero.url;
  if (manualGallery.length || approvedGallery.length) updates.galleryImageUrls = manualGallery.length ? manualGallery : approvedGallery.map(row => row.url);
  if (color) updates.brandColorHex = color;
  const previousOriginals = (await preview.organizationRef.get()).data()?.websiteBrandOriginalAssets || {};
  updates.websiteBrandOriginalAssets = { ...previousOriginals,
    ...(logo ? { logo: logo.originalUrl } : {}),
    ...(hero ? { hero: hero.originalUrl } : {}),
    ...(approvedGallery.length ? { gallery: approvedGallery.map(row => row.originalUrl) } : {}) };
  const candidateAssets = {};
  for (const asset of [logo, hero, ...gallery].filter(Boolean)) {
    for (const candidate of preview.candidates || []) if ((candidate.sourceUrl || candidate.url) === asset.requestedUrl) candidateAssets[candidate.id] = asset.url;
  }
  updates.websiteBrandCandidateAssets = candidateAssets;
  if (final) applyCompleteSelection(final, candidateAssets, updates);
  let duplicate = false; let savedBrand = updates;
  await ctx.db.runTransaction(async transaction => {
    const currentPreview = await transaction.get(previewRef);
    if (clean(currentPreview.data()?.status) === 'committed') {
      duplicate = true;
      savedBrand = currentPreview.data()?.savedBrand || {};
      return;
    }
    // Cleanup or expiry may occur while the selected images are being copied.
    assertActivePreview(currentPreview.data() || {});
    transaction.set(preview.organizationRef, updates, { merge: true });
    transaction.update(previewRef, { status: 'committed', committedAt: at, committedByRef: ctx.actor.userRef, savedBrand: updates, savedAssets: { logo, hero, gallery: approvedGallery } });
  });
  return { ok: true, duplicate, organizationRefPath: refPath(preview.organizationRef), savedBrand };
}

exports.previewCommandWebsiteBrandService = previewCommandWebsiteBrandService;
exports.commitCommandWebsiteBrandService = commitCommandWebsiteBrandService;
exports.previewCommandWebsiteBrand = onCall({ region: REGION, cors: true, timeoutSeconds: 300, memory: '1GiB', secrets: [OPENAI_API_KEY] }, request => previewCommandWebsiteBrandService(request, { apiKey: OPENAI_API_KEY.value(), model: COMMAND_WEBSITE_BRAND_OPENAI_MODEL.value() }));
exports.commitCommandWebsiteBrand = onCall({ region: REGION, cors: true, timeoutSeconds: 300, memory: '1GiB' }, commitCommandWebsiteBrandService);
exports.cleanupCommandWebsiteBrandPreviews = onSchedule({ region: REGION, schedule: 'every 24 hours', timeoutSeconds: 300 }, cleanupCommandWebsiteBrandPreviewsService);
exports._test = {   candidateFailureCounts, safeErrorDetails, sourceHost, wordpressHomepageHtml, completeSelection, applyCompleteSelection, cleanupCommandWebsiteBrandPreviewsService, prepareImage, saveRemoteImage, leadOrganization, brandFields, privateIp, absoluteUrl, srcsetUrl, imageCandidates, declaredColors, fallbackSelection, extension, detectedImageExtension, sourceKey, ownedStorageUrl };


exports.getCommandOrganizationBrand = onCall({ region: REGION, cors: true }, getCommandOrganizationBrandService);
exports.saveCommandOrganizationBrand = onCall({ region: REGION, cors: true }, saveCommandOrganizationBrandService);

