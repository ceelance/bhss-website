# Working in this repo

`README.md` explains the architecture — how a post reaches the site, why the site
is generated, the nav/tag/paging model, and the September 2026 cutover. Read it
before changing the build. This file is only the things an agent gets wrong.

## Two repos, one system

The portal lives in **`C:\Users\Siamtea\BHSS Result System`** (GitHub Pages +
Google Apps Script, deployed by pasting `.gs` files into the Apps Script editor).
Its `CLAUDE.md` is the authority on that side. Ask for it as an additional
working directory when a change spans both.

**`content/posts.json` and `content/faculty.json` are written by the portal, not
by hand.** Both are rebuilt wholesale from the sheets on every publish, so an
edit made here is overwritten by the next one. `img/posts/` and `img/staff/` are
likewise uploaded by the portal.

**`portal/publish-faculty.gs` is Apps Script.** It sits here because the shape it
must produce is defined by the build next door, but it *runs in the portal's
Apps Script project* — so a change to it is not live until it is pasted in and a
new deployment version is published. It cannot be tested from this repo.

## Rules that must not be broken

- **No npm dependencies, ever.** The deploy workflow holds an SSH key with full
  access to the hosting account; every package in that job is a path to that key.
  Node standard library only. This is why `tools/markdown.mjs` exists.
- **The faculty page carries prospectus facts only** — name, title, subject,
  photograph. **Never an email address, never a phone number.** The data comes
  from the Users sheet, which holds both.
- **A staff photograph is a consent artifact.** Refusal, removal, going
  off-website and user deletion must each *delete the file* from this repo, not
  merely clear the sheet cell — the repo is public and the path is guessable. An
  admin must never publish over a `photo_consent` of `no`.
- **Never invent staff names, posts or notices**, not even as sample data. This
  repo deploys straight to a live school website.
- `rsync --delete` is pointed at `public_html`. Anything there that is not in
  `dist/` is erased. `DEPLOY_PATH`, `SITE_BASE_URL` and `IS_PREVIEW` are one
  setting in three lines and change together.

## Traps

- **`site/.htaccess` is 68 redirects and the whole site's routing.** A bad page
  is one bad page; a bad `.htaccess` is everything. It ships only when
  `IS_PREVIEW` is `'false'`.
- **Published slugs are frozen.** They are the targets of deployed redirects and
  of links parents have already shared on WhatsApp.
- **`HONORIFICS` drives the initials on a photo-less card.** A missing entry put
  wrong initials on 27 of 64 staff live. It is duplicated in
  `tools/staff-photos.py` — change both.
- CSS is cache-busted by content hash (`styles.css?v=<sha256[:8]>`), which is the
  only reason a 7-day cache on it is safe.
- Python here is a Windows binary: it needs `D:\...` paths, not Git Bash
  `/d/...`, and `PYTHONIOENCODING=utf-8` or Mizo diacritics crash the console.

## Commands

```
node tools/build.mjs          # writes dist/ — always run before claiming a change works
node tools/test-markdown.mjs  # the renderer's tests
```

Deploy is automatic on push to `main`. Key constants live in `tools/build.mjs`:
`PER_PAGE`, `NAV_GROUPS`, `STAFF_GROUP_ORDER`, `HONORIFICS`.
