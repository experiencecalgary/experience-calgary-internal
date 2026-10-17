# Business asset import backend

## Deployment

Deploy only these functions after merging:

```sh
firebase deploy --only functions:previewCommandWebsiteBrand,functions:commitCommandWebsiteBrand,functions:saveCommandOrganizationBrand,functions:cleanupCommandWebsiteBrandPreviews
```

Include `saveCommandOrganizationBrand` because its shared URL validator now rejects temporary preview URLs as permanent assets.

The cleanup schedule is new and is exported through the existing `commandWebsiteBrand` assignment in `functions/entrypoint.js`. No dependency, Firestore index, Storage rule, or Lead-schema changes are required by this patch. Existing Storage access still needs to allow the app to load its download-token URLs. No live Firebase deployment was performed while preparing the PR.

## Storage and Firestore

- Temporary validated source images and WebP thumbnails: `PartnerImages/{organizationId}/website-previews/{previewId}/`.
- Approved originals and WebP display images: `PartnerImages/{organizationId}/website-imports/{previewId}/{uniqueId}/`.
- Existing manual uploads: `PartnerImages/{organizationId}/manual/`.
- Approved URLs and colour: existing fields on `commandOrganizations/{organizationId}`.
- Preview candidates, source URLs, palette, warnings, approval audit: `commandWebsiteBrandPreviews/{previewId}`.

Preview expiry remains 24 hours. The daily cleanup processes up to 50 expired preview documents per invocation, deleting only their temporary `website-previews` prefix. It retains approval audit data and all permanent images. Interrupted preview requests are included because their cleanup record is written before uploading. Expired previews must be fetched again. Temporary preview URLs cannot be passed as permanent manual assets; use their candidate IDs to import them.

## Existing widget compatibility

`candidates[].url` now points to a validated Storage-hosted thumbnail. Existing widgets can display these without relying on the source website's CORS or image type. `sourceUrl` retains the website URL; dimensions describe the original. Candidate IDs and the existing `selection` request are supported. Existing previews still import through byte-based validation, accepting valid WebP even if its HTTP header says JPEG.

The response additionally exposes `declaredColors`, `warnings`, `previewUrl`, `format`, and `validated`. New previews check up to four linked stylesheets (256 KiB each) and the 18 highest-ranked sources, with a discovery time budget. CSS imports and JavaScript-rendered pages are not crawled. JPEG, PNG, WebP, and self-contained SVG are supported; active or external-resource SVGs are rejected. SVG display images are rasterized at increased density within the output bounds. Raster originals are never enlarged. OpenAI ranks existing assets; generative logo enhancement is a separate follow-up.

This backend PR cannot fix the embedded Flutter widget's layout, scroll area, or invisible chooser buttons. Those require the frontend replacement.

## Complete save for the updated frontend

After preview, call `commitCommandWebsiteBrand` once with `previewId` and `finalSelection` instead of the legacy `selection`. Include every slot:

```json
{
  "previewId": "returned-preview-id",
  "finalSelection": {
    "logo": { "candidateId": "candidate_1" },
    "hero": null,
    "gallery": [
      { "url": "https://firebasestorage.googleapis.com/v0/b/YOUR_BUCKET/o/PartnerImages%2FORG%2Fmanual%2Fimage.png?alt=media&token=TOKEN" },
      { "candidateId": "candidate_3" }
    ],
    "brandColorHex": "#557353"
  }
}
```

- `null` clears logo or hero. An empty gallery clears it; at most four entries are accepted.
- A slot uses either `candidateId` or an existing permanent project Storage `url`.
- Mixed gallery selections preserve the submitted order; repeated URLs are deduplicated.
- Empty colour clears it. Nonempty colour must be six-digit hex.
- Final image uploads complete before the Organization and preview approval are written in one Firestore transaction. A failing image reports slot and candidate details and leaves Organization branding unchanged. Storage uploads themselves are not transactional; a failed or racing commit can leave unreferenced files in its unique import folder, as with the existing importer.
- On success apply `savedBrand` to the editor and do not call `saveCommandOrganizationBrand` a second time.
- A committed preview is idempotent. Fetch a new preview for a different candidate selection. For manual-only edits without a preview, the existing `saveCommandOrganizationBrand` remains available.

## Validation

Run from `functions` with the repository dependencies installed:

```sh
node --test test/commandWebsiteBrand.test.js test/commandWebsiteBrandRegression.test.js
```

Regression tests use real Sharp encoding/decoding and in-memory Firestore/Storage/network doubles. They cover the address/colour regression, stylesheet backgrounds, mislabeled WebP, SVG rasterization and rejection, corrupt sources, thumbnail staging, legacy imports, complete saves, failure preservation, expiry cleanup, and permanent-file protection. They do not replace a live Firebase smoke test after deployment.
