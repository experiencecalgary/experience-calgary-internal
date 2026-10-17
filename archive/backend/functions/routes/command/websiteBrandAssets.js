'use strict';

const sharp = require('sharp');

const MAX_PIXELS = 60000000;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml' };

// Examine declarations, never arbitrary HTML text (e.g. the street address #205).
function cssColors(css) {
  const values = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/gi, '');
  for (const declaration of source.matchAll(/(?:^|[;{])\s*(--[\w-]+|[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (!/^(--|color$|background|border|outline|fill$|stroke$|box-shadow$|text-shadow$|caret-color$|accent-color$)/i.test(declaration[1])) continue;
    for (const match of declaration[2].matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})(?![\w-])/gi)) {
      let hex = match[1].toUpperCase();
      if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
      if (!['000000', 'FFFFFF', 'F5F5F5', 'EEEEEE'].includes(hex)) values.push(`#${hex}`);
    }
    for (const match of declaration[2].matchAll(/rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*(?:1|1\.0+))?\s*\)/gi)) {
      const rgb = match.slice(1).map(Number);
      if (rgb.every(v => v <= 255) && !rgb.every(v => v === 0) && !rgb.every(v => v === 255)) values.push(`#${rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
    }
  }
  return values;
}

function declaredColors(html, stylesheets = []) {
  const css = [...stylesheets];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css.push(match[1]);
  for (const match of html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) css.push(match[1] || match[2]);
  // Retain support for callers passing CSS directly.
  if (!html.includes('<')) css.push(html);
  const counts = new Map();
  for (const value of css.flatMap(cssColors)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([value]) => value);
}

function cssImages(css, base) {
  const result = [];
  // Only image-bearing declarations: do not mistake font URLs for images.
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:background(?:-image)?|content)\s*:\s*([^;}]+)/gi)) {
    for (const image of match[1].matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi)) {
      try {
        const url = new URL(image[1], base);
        if (url.protocol === 'https:' && !url.username && !url.password) result.push(url.toString());
      } catch (_) { /* Invalid CSS URLs are not candidates. */ }
    }
  }
  return [...new Set(result)];
}

async function prepareImage(buffer) {
  // SVGs may be rasterized, but must be self-contained and non-executable.
  const raster = buffer.length >= 12 && (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) ||
    (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'));
  if (!raster) {
    const svg = buffer.toString('utf8');
    if (!/<svg\b/i.test(svg) || /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\bon\w+\s*=|@import|(?:href|src)\s*=\s*['"]\s*(?!#)|url\(\s*['"]?\s*(?!#)/i.test(svg)) {
      throw new Error('Use a supported raster image or a self-contained SVG without active content.');
    }
  }
  const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
  if (!MIME[metadata.format] || !metadata.width || !metadata.height) throw new Error('Unsupported image format. Use PNG, JPEG, WebP or a self-contained SVG.');
  // Encoding forces a complete decode; metadata alone accepts truncated files.
  const density = metadata.format === 'svg' ? Math.max(72, Math.min(288, 72 * 1920 / Math.max(metadata.width, metadata.height))) : 72;
  const display = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning', density }).rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 }).toBuffer();
  const thumbnail = await sharp(display).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  return { display, thumbnail, width: metadata.width, height: metadata.height,
    ext: metadata.format === 'jpeg' ? 'jpg' : metadata.format, contentType: MIME[metadata.format] };
}

module.exports = { cssColors, declaredColors, cssImages, prepareImage };
