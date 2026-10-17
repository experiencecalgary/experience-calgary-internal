# Experience Calgary internal archive

Source: experiencecalgary/experience-calgary-backend (main), verified 2026-10-17.

Purpose: preserve the EC Reps, Command Center, ExMail and Sara source for a future separate application. No production Firebase functions should be deleted or redeployed as part of archival work.

The FlutterFlow internal-only source archive is held separately as `experience-calgary-internal-flutterflow-archive.zip`; it has not been committed here.

Backend source transfer is verified for the cleanup set. All 208 function source, script, and test files removed by the backend cleanup are present under `archive/backend/` and match the pre-cleanup source after line-ending normalization.

This verification does not make the archive deployable. Production deployment ownership remains with the source repository until a separately reviewed migration is approved.
