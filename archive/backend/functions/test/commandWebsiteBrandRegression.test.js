'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharp = require('sharp');
const helpers = require('../routes/command/websiteBrandAssets');

function fixture(resources = {}) {
  const documents = new Map([['users/rep', { userType: 'rep', role: 'platform_admin' }], ['commandOrganizations/org', { ownerUid: 'rep', logoUrl: '', heroImageUrl: '', galleryImageUrls: [] }]]);
  const objects = new Map(); const writes = []; const requests = [];
  let sequence = 0;
  const now = () => ({ toMillis: () => Date.now(), toDate: () => new Date() });
  const snapshot = key => ({ id: key.split('/').pop(), ref: doc(key), exists: documents.has(key), data: () => documents.get(key) });
  const doc = key => ({ id: key.split('/').pop(), path: key, parent: { id: key.split('/')[0] },
    get: async () => snapshot(key), set: async value => documents.set(key, value),
    update: async value => documents.set(key, { ...documents.get(key), ...value }) });
  const db = { doc, collection: name => ({ doc: id => doc(`${name}/${id || 'preview_test_' + ++sequence}`),
    where: () => ({ limit: () => ({ get: async () => ({ docs: [...documents.keys()].filter(key => key.startsWith(`${name}/`) && documents.get(key).expiresAt?.toMillis() < Date.now()).map(snapshot) }) }) }) }),
    runTransaction: async work => work({ get: async ref => ref.get(), set: (ref, value) => { documents.set(ref.path, { ...documents.get(ref.path), ...value }); }, update: (ref, value) => { documents.set(ref.path, { ...documents.get(ref.path), ...value }); } }) };
  const firestore = () => db;
  firestore.Timestamp = { now, fromMillis: ms => ({ toMillis: () => ms, toDate: () => new Date(ms) }) };
  firestore.FieldValue = { delete: () => undefined };
  const bucket = { name: 'test.firebasestorage.app', file: name => ({
    save: async (bytes, options) => { objects.set(name, Buffer.from(bytes)); writes.push({ name, options }); },
    download: async () => { if (!objects.has(name)) throw new Error('Missing staged original'); return [objects.get(name)]; },
  }), deleteFiles: async ({ prefix }) => { for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key); } };
  const file = path.resolve(__dirname, '../routes/command/commandWebsiteBrand.js');
  const realRequire = createRequire(file);
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require: name => name === 'firebase-admin' ? { firestore, storage: () => ({ bucket: () => bucket }) } : name === 'node:dns' ? { promises: { lookup: async () => [{ address: '8.8.8.8' }] } } : realRequire(name),
    fetch: async (url, options = {}) => {
      requests.push(String(url));
      const configured = resources[String(url)];
      const resource = typeof configured === 'function' ? configured(options) : configured;
      return new Response(resource?.body || 'not found', { status: resource ? 200 : 404, headers: { 'content-type': resource?.type || 'text/html' } });
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { backend: module.exports, db, documents, objects, requests, writes,
    request: data => ({ auth: { uid: 'rep' }, data: { organizationRefPath: 'commandOrganizations/org', ...data } }) };
}

async function raster() { return sharp({ create: { width: 120, height: 80, channels: 3, background: '#557353' } }).webp().toBuffer(); }

test('street address never becomes a colour; external CSS provides the actual palette', () => {
  assert.deepEqual(helpers.declaredColors('<p>Address: #205-8</p><a href="#abc">Jump</a>'), []);
  assert.deepEqual(helpers.declaredColors('<p>#205-8</p>', [':root { --primary-2: #557353; --accent-2: #E7B1A4; }']), ['#557353', '#E7B1A4']);
  assert.deepEqual(helpers.declaredColors('<div style="color:#abc">Hello</div><style>h2{color:rgb(85,115,83)}</style>'), ['#557353', '#AABBCC']);
});

test('stylesheet image discovery resolves against CSS URL and ignores fonts and data URIs', () => {
  assert.deepEqual(helpers.cssImages('@font-face{src:url(font.woff)} .hero{background-image:url(../media/chai.jpg)} .x{background:url(data:image/png;base64,aaa)}', 'https://example.com/css/style.css'), ['https://example.com/media/chai.jpg']);
});

test('complete decoding accepts WebP bytes and rejects HTML and truncated raster data', async () => {
  const buffer = await raster(); const result = await helpers.prepareImage(buffer);
  assert.equal(result.ext, 'webp'); assert.equal(result.contentType, 'image/webp');
  assert.equal((await sharp(result.thumbnail).metadata()).format, 'webp');
  await assert.rejects(helpers.prepareImage(Buffer.from('<html>Blocked</html>')));
  await assert.rejects(helpers.prepareImage(buffer.subarray(0, 40)));
});

test('self-contained SVG logos render to WebP; active or external SVG content is rejected', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#557353"/></svg>';
  const result = await helpers.prepareImage(Buffer.from(svg));
  assert.equal(result.ext, 'svg'); assert.equal((await sharp(result.display).metadata()).format, 'webp');
  await assert.rejects(helpers.prepareImage(Buffer.from(svg.replace('</svg>', '<image href="https://example.com/x"/></svg>'))), /self-contained/);
  await assert.rejects(helpers.prepareImage(Buffer.from(svg.replace('</svg>', '<script>alert(1)</script></svg>'))), /self-contained/);
});

test('preview validates candidates, hosts thumbnails, and commits despite JPEG-labelled WebP', async () => {
  const bytes = await raster();
  const f = fixture({
    'https://example.com/': { type: 'text/html', body: '<link rel="stylesheet" href="/style.css"><p>#205-8</p><img src="/bad.jpg"><img class="logo" src="/logo.jpg">' },
    'https://example.com/style.css': { type: 'text/css', body: ':root{--brand:#557353} .hero{background-image:url(/chai.jpg)}' },
    'https://example.com/logo.jpg': { type: 'image/jpeg', body: bytes },
    'https://example.com/chai.jpg': { type: 'image/jpeg', body: bytes },
    'https://example.com/bad.jpg': { type: 'text/html', body: '<html>Denied</html>' },
  });
  const preview = await f.backend.previewCommandWebsiteBrandService(f.request({ websiteUrl: 'https://example.com/' }));
  assert.equal(preview.candidates.length, 2);
  assert.equal(preview.suggestedSelection.brandColorHex, '#557353');
  assert.ok(preview.warnings.some(w => w.includes('bad.jpg')));
  assert.ok(preview.candidates.every(c => c.url.startsWith('https://firebasestorage.googleapis.com/') && c.width === 120));
  const count = f.requests.length;
  const result = await f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId, selection: preview.suggestedSelection }));
  assert.equal(f.requests.length, count, 'commit uses staged originals instead of refetching website');
  assert.match(result.savedBrand.logoUrl, /PartnerImages%2Forg%2Fwebsite-imports/);
  assert.ok(f.writes.every(w => w.name.startsWith('PartnerImages/org/')));
  assert.ok(f.writes.filter(w => !w.name.endsWith('-preview.webp')).every(w => w.options.contentType === 'image/webp'));
  assert.equal(f.documents.get('commandOrganizations/org').brandColorHex, '#557353');
  const duplicate = await f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId }));
  assert.equal(duplicate.duplicate, true);
});

test('legacy previews also import JPEG-labelled WebP correctly', async () => {
  const f = fixture({ 'https://example.com/legacy.jpg': { type: 'image/jpeg', body: await raster() } });
  const asset = await f.backend._test.saveRemoteImage('https://example.com/legacy.jpg', 'PartnerImages/org/website-imports/test/logo');
  assert.ok(asset.storagePath.endsWith('.webp'));
  assert.equal(f.writes[0].options.contentType, 'image/webp');
});

test('complete selection preserves mixed gallery order, clears slots, and supports manual-only saves', async () => {
  const bytes = await raster();
  const f = fixture({ 'https://example.com/': { type: 'text/html', body: '<img src="/photo.webp">' }, 'https://example.com/photo.webp': { type: 'image/webp', body: bytes } });
  const preview = await f.backend.previewCommandWebsiteBrandService(f.request({ websiteUrl: 'https://example.com/' }));
  const manual = 'https://firebasestorage.googleapis.com/v0/b/test.firebasestorage.app/o/PartnerImages%2Forg%2Fmanual%2Fa.png?alt=media';
  const finalSelection = { logo: null, hero: { url: manual }, gallery: [{ url: manual }, { candidateId: preview.candidates[0].id }], brandColorHex: '' };
  const saved = await f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId, finalSelection }));
  assert.equal(saved.savedBrand.logoUrl, ''); assert.equal(saved.savedBrand.heroImageUrl, manual);
  assert.equal(saved.savedBrand.galleryImageUrls[0], manual); assert.equal(saved.savedBrand.galleryImageUrls.length, 2);
  assert.equal(saved.savedBrand.brandColorHex, '');
  const p2 = await f.backend.previewCommandWebsiteBrandService(f.request({ websiteUrl: 'https://example.com/' }));
  const cleared = await f.backend.commitCommandWebsiteBrandService(f.request({ previewId: p2.previewId, finalSelection: { logo: null, hero: null, gallery: [], brandColorHex: '' } }));
  assert.equal(cleared.savedBrand.galleryImageUrls.length, 0);
  assert.equal(cleared.savedBrand.heroImageUrl, '');
});

test('unknown candidate and missing staged image fail without modifying Organization', async () => {
  const f = fixture({ 'https://example.com/': { type: 'text/html', body: '<img src="/photo.webp">' }, 'https://example.com/photo.webp': { type: 'image/webp', body: await raster() } });
  const preview = await f.backend.previewCommandWebsiteBrandService(f.request({ websiteUrl: 'https://example.com/' }));
  const before = JSON.stringify(f.documents.get('commandOrganizations/org'));
  await assert.rejects(f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId, selection: { heroCandidateId: 'missing' } })), /Unknown image/);
  f.objects.clear();
  await assert.rejects(f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId, selection: { heroCandidateId: preview.candidates[0].id } })), /Hero could not be saved/);
  assert.equal(JSON.stringify(f.documents.get('commandOrganizations/org')), before);
});

test('cleanup removes temporary files only and expires abandoned previews', async () => {
  const f = fixture(); const key = 'commandWebsiteBrandPreviews/preview_test_1';
  f.documents.set(key, { status: 'preparing', expiresAt: { toMillis: () => 1 }, previewStoragePrefix: 'PartnerImages/org/website-previews/preview_test_1/' });
  f.objects.set('PartnerImages/org/website-previews/preview_test_1/a.webp', Buffer.from('temp'));
  f.objects.set('PartnerImages/org/website-imports/approved/logo.webp', Buffer.from('saved'));
  await f.backend._test.cleanupCommandWebsiteBrandPreviewsService();
  assert.equal(f.objects.size, 1); assert.ok(f.objects.has('PartnerImages/org/website-imports/approved/logo.webp'));
  assert.equal(f.documents.get(key).status, 'expired');

});

test('temporary preview URLs cannot be saved as permanent manual assets', () => {
  const f = fixture();
  assert.throws(() => f.backend._test.completeSelection({ logo: { url: 'https://firebasestorage.googleapis.com/v0/b/test.firebasestorage.app/o/PartnerImages%2Forg%2Fwebsite-previews%2Fp%2Fa.webp?alt=media' }, hero: null, gallery: [], brandColorHex: '' }, 'test.firebasestorage.app'), /Firebase Storage/);
});

test('cleanup retains committed assets and retry data', async () => {
  const f = fixture(); const key = 'commandWebsiteBrandPreviews/preview_test_1';
  const permanent = 'PartnerImages/org/website-imports/approved/logo.webp';
  f.documents.set(key, { status: 'committed', expiresAt: { toMillis: () => 1 }, previewStoragePrefix: 'PartnerImages/org/website-previews/preview_test_1/', savedBrand: { logoUrl: permanent } });
  f.objects.set('PartnerImages/org/website-previews/preview_test_1/a.webp', Buffer.from('temp'));
  f.objects.set(permanent, Buffer.from('saved'));
  await f.backend._test.cleanupCommandWebsiteBrandPreviewsService();
  assert.equal(f.objects.size, 1); assert.ok(f.objects.has(permanent));
  assert.equal(f.documents.get(key).status, 'committed');
  assert.equal(f.documents.get(key).savedBrand.logoUrl, permanent);
});

test('fallback never labels an arbitrary photograph as the business logo', () => {
  const f = fixture();
  const selection = f.backend._test.fallbackSelection([{ id: 'photo', kind: 'image' }], []);
  assert.equal(selection.logoCandidateId, ''); assert.equal(selection.heroCandidateId, 'photo');
});


test('expiry during image copying prevents a late Organization update', async () => {
  const f = fixture({ 'https://example.com/': { type: 'text/html', body: '<img src="/photo.webp">' }, 'https://example.com/photo.webp': { type: 'image/webp', body: await raster() } });
  const preview = await f.backend.previewCommandWebsiteBrandService(f.request({ websiteUrl: 'https://example.com/' }));
  const before = JSON.stringify(f.documents.get('commandOrganizations/org'));
  const originalTransaction = f.db.runTransaction;
  f.db.runTransaction = async work => {
    const data = f.documents.get(`commandWebsiteBrandPreviews/${preview.previewId}`);
    data.status = 'expired'; data.expiresAt = undefined;
    return originalTransaction(work);
  };
  await assert.rejects(f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId, selection: { heroCandidateId: preview.candidates[0].id } })), /expired/);
  assert.equal(JSON.stringify(f.documents.get('commandOrganizations/org')), before);
});

test('committed previews remain idempotent after expiry, but expired uncommitted previews fail', async () => {
  const f = fixture({ 'https://example.com/': { type: 'text/html', body: '<img src="/photo.webp">' }, 'https://example.com/photo.webp': { type: 'image/webp', body: await raster() } });
  const preview = await f.backend.previewCommandWebsiteBrandService(f.request({ websiteUrl: 'https://example.com/' }));
  await f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId, selection: { heroCandidateId: preview.candidates[0].id } }));
  const data = f.documents.get(`commandWebsiteBrandPreviews/${preview.previewId}`);
  data.expiresAt = { toMillis: () => 1 };
  const result = await f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId }));
  assert.equal(result.duplicate, true);
  data.status = 'expired'; data.expiresAt = undefined;
  await assert.rejects(f.backend.commitCommandWebsiteBrandService(f.request({ previewId: preview.previewId })), /expired/);
});


test('candidate diagnostics group failures by the exact processing stage', () => {
  const f = fixture();
  const counts = f.backend._test.candidateFailureCounts([
    { stage: 'download' },
    { stage: 'download' },
    { stage: 'decode' },
    { stage: 'upload-original' },
    { stage: 'upload-preview' },
    {},
  ]);
  assert.equal(counts.download, 2);
  assert.equal(counts.decode, 1);
  assert.equal(counts['upload-original'], 1);
  assert.equal(counts['upload-preview'], 1);
  assert.equal(counts.unknown, 1);
  const details = f.backend._test.safeErrorDetails({
    code: 'storage/retry-limit-exceeded',
    message: 'upload failed',
  });
  assert.equal(details.errorCode, 'storage/retry-limit-exceeded');
  assert.equal(details.errorMessage, 'upload failed');
  assert.equal(f.backend._test.sourceHost('https://example.com/private/path?token=secret'), 'example.com');
});


test('empty importer HTML retries with browser headers and keeps the validated pipeline', async () => {
  const bytes = await raster();
  const f = fixture({
    'https://example.com/': options => {
      const userAgent = String(options?.headers?.['user-agent'] || '');
      return userAgent.includes('Mozilla/5.0')
        ? { type: 'text/html', body: '<img class="logo" src="/logo.webp">' }
        : { type: 'text/html', body: '<html><body>Automated request interstitial</body></html>' };
    },
    'https://example.com/logo.webp': { type: 'image/webp', body: bytes },
  });
  const result = await f.backend.previewCommandWebsiteBrandService(
    f.request({ websiteUrl: 'https://example.com/' }),
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, 'logo');
  assert.equal(result.candidates[0].validated, true);
  assert.equal(f.requests.filter(url => url === 'https://example.com/').length, 2);
  assert.ok(f.requests.includes('https://example.com/logo.webp'));
});


test('WordPress fallback recovers homepage imagery and theme logos from bounded APIs', async () => {
  const bytes = await raster();
  const pagesApi = 'https://example.com/wp-json/wp/v2/pages?per_page=100&_fields=link,content';
  const mediaApi = 'https://example.com/wp-json/wp/v2/media?search=logo&per_page=20&_fields=source_url,slug,alt_text,media_details';
  const f = fixture({
    'https://example.com/': { type: 'text/html', body: '<html><body>Host interstitial</body></html>' },
    [pagesApi]: {
      type: 'application/json',
      body: JSON.stringify([
        {
          link: 'https://example.com/',
          content: { rendered: '<img class="hero" src="/hero.webp">' },
        },
      ]),
    },
    [mediaApi]: {
      type: 'application/json',
      body: JSON.stringify([
        {
          source_url: 'https://example.com/free-spirit-logo.webp',
          slug: 'free-spirit-logo',
          alt_text: 'Free Spirit Dance logo',
          media_details: { width: 530, height: 262 },
        },
      ]),
    },
    'https://example.com/hero.webp': { type: 'image/webp', body: bytes },
    'https://example.com/free-spirit-logo.webp': { type: 'image/webp', body: bytes },
  });
  const result = await f.backend.previewCommandWebsiteBrandService(
    f.request({ websiteUrl: 'https://example.com/' }),
  );
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.some(candidate => candidate.kind === 'logo'));
  assert.ok(result.candidates.some(candidate => candidate.kind === 'hero'));
  assert.ok(f.requests.includes(pagesApi));
  assert.ok(f.requests.includes(mediaApi));
  assert.ok(f.requests.includes('https://example.com/free-spirit-logo.webp'));
});

test('logo scoring recognizes title and filename hints', () => {
  const f = fixture();
  const rows = f.backend._test.imageCandidates(
    '<img src="/free-spirit-logo.png" title="Free Spirit Dance">',
    'https://example.com/',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'logo');
});
