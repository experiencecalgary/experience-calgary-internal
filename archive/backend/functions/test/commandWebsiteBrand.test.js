'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const brand = require('../routes/command/commandWebsiteBrand')._test;

test('blocks private and reserved network addresses', () => {
  for (const value of ['127.0.0.1', '10.0.0.8', '172.16.1.2', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1']) {
    assert.equal(brand.privateIp(value), true, value);
  }
  assert.equal(brand.privateIp('8.8.8.8'), false);
});

test('normalizes only https image URLs and rejects social embeds', () => {
  assert.equal(brand.absoluteUrl('/hero.jpg', 'https://example.com/page'), 'https://example.com/hero.jpg');
  assert.equal(brand.absoluteUrl('http://example.com/logo.png', 'https://example.com'), '');
  assert.equal(brand.absoluteUrl('https://instagram.com/photo.jpg', 'https://example.com'), '');
});

test('selects URLs rather than width descriptors from srcset', () => {
  assert.equal(brand.srcsetUrl('/small.jpg 480w, /large.jpg 1280w'), '/large.jpg');
});

test('extracts and deduplicates likely brand images', () => {
  const html = `
    <meta property="og:image" content="/hero.jpg">
    <img class="site-logo" src="/logo.png" alt="Acme logo" width="400">
    <img src="/hero.jpg" width="1400" height="800">
    <div style="background-image:url('/project.webp')"></div>`;
  const rows = brand.imageCandidates(html, 'https://example.com');
  assert.equal(rows.filter(row => row.url.endsWith('/hero.jpg')).length, 1);
  assert.equal(rows.find(row => row.url.endsWith('/logo.png')).kind, 'logo');
  assert.ok(rows.some(row => row.url.endsWith('/project.webp')));
});

test('extracts useful declared colors and ignores plain black and white', () => {
  assert.deepEqual(brand.declaredColors('color:#D6A332;background:#000000;border:#d6a332'), ['#D6A332']);
});

test('allows manual assets only from the configured Firebase Storage bucket', () => {
  const good = 'https://firebasestorage.googleapis.com/v0/b/experience-app-ce493.appspot.com/o/PartnerImages%2Fmanual.png?alt=media';
  assert.equal(brand.ownedStorageUrl(good, 'experience-app-ce493.appspot.com'), good);
  assert.throws(() => brand.ownedStorageUrl('https://example.com/manual.png', 'experience-app-ce493.appspot.com'), /Firebase Storage/);
});

test('uses stable source keys and supported image extensions', () => {
  assert.equal(brand.sourceKey('https://example.com/a.png'), brand.sourceKey('https://example.com/a.png'));
  assert.equal(brand.extension('image/webp; charset=binary'), 'webp');
  assert.equal(brand.extension('text/html'), '');
  assert.equal(brand.detectedImageExtension(Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(brand.detectedImageExtension(Buffer.from('not an image')), '');
});
