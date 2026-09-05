# Staff photographs

One picture per member of staff, referenced from `content/faculty.json`.
**Uploaded by the portal, not committed by hand** — the same path post pictures
already take. Filenames are `<slug>-<6 hex>.webp`, the hex being a digest of the
person's address: two staff called "Sir Joseph" would otherwise overwrite one
another's face.

A teacher puts their own here by answering the card on their portal home, or an
admin does it for them. **A file here is somebody's consent, not just an asset** —
if a person's photograph is removed or they leave the school, the file is
deleted, because a cleared reference leaves the picture in this public repo at a
guessable address. Don't add one by hand for a member of staff who has not been
asked; `tools/staff-photos.py` is the route for a batch the office already holds.

A card without a photograph is not a fault. It shows the person's initials on a
tinted tile, so a half-photographed staff list looks deliberate rather than
broken, and nobody is represented by a stock face belonging to someone else.

## What to upload

- **Square**, 400 × 400 or larger. The card frames a square, and a square
  survives whatever is actually to hand — a phone portrait, a face cropped out of
  a group photo, a scan. A tall frame would cut heads off.
- **WebP**, quality ~82. Every other picture on this site is WebP; a JPEG works
  but is bigger for the same result.
- **The face roughly centred.** The card fills its frame with `object-fit: cover`,
  so anything far off-centre gets cropped away.

## A note on what belongs here

Only what a school prints in a prospectus goes on the public site: a name, a
title, a subject, a photograph. Never an email address, never a phone number.
The portal holds those and has a sign-in in front of them; this page is read by
anyone at all.
