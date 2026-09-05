# baptisthss.in — the school website

A generated static site for Baptist Higher Secondary School, deployed to
Hostinger. It replaces the WordPress site that lived here before.

**No build tools to install.** The generator is plain Node with **no npm
dependencies** — see "Why no dependencies" below.

```
node tools/build.mjs      # writes dist/
node tools/test-markdown.mjs
```

Then open `dist/index.html` in a browser. (Links between pages are relative, so
opening the files directly works.)

## How a post reaches the website

```
Someone writes a post in the school portal's admin panel
  → saved to the Website_Posts sheet          (the source of truth)
  → published: content/posts.json is committed to THIS repo
  → that push triggers .github/workflows/deploy.yml
  → node tools/build.mjs renders dist/
  → rsync over SSH to Hostinger
```

A post appears on the site a minute or two after Publish. **`content/posts.json`
is written by the portal, not by hand** — it is rebuilt wholesale from the sheet
on every publish, so an edit made here is overwritten by the next one.

## Why the site is generated rather than fetching its posts

WhatsApp and Google read `og:image` and `og:title` out of a page's HTML **without
running its JavaScript**. A page that fetched its own content would therefore show
one identical link preview for every post — defeating the per-post thumbnail on
the channel school news actually travels by — and the posts would not be indexed.

So every post gets a real file at `news/<slug>/index.html` carrying its own tags.
That is the whole reason publishing takes a minute instead of being instant.

## Why no dependencies

The deploy workflow holds an SSH key with full access to the hosting account.
Every npm package in that job is a path to that key. `tools/markdown.mjs` is a
deliberately small renderer we own outright; it escapes everything first and then
re-introduces only the tags it chose, so it cannot emit a tag we did not intend.

## Layout

```
site/layout.html        the page shell — <head>, header, nav, footer
site/pages/*.html       one file per page, with a small <!-- title: … --> header
site/styles.css         all the CSS
site/.htaccess          canonical redirects, the old-URL map, caching
content/posts.json      WRITTEN BY THE PORTAL — do not edit by hand
content/faculty.json    WRITTEN BY THE PORTAL — do not edit by hand
assets/                 crest, favicon, default share image
assets/defaults/        stand-in pictures for a post with none of its own
img/posts/              post pictures, uploaded by the portal
img/staff/              staff photographs, uploaded by the portal
portal/                 Apps Script belonging to the PORTAL, kept beside the
                        content it writes here
tools/build.mjs         the generator
tools/markdown.mjs      the post-body renderer
```

Adding a page: drop an HTML file in `site/pages/`, give it a `nav:` and an
`order:` in the header comment if it should appear in the menu. Add
`group: About` as well and it goes inside that menu instead of along the top —
groups are declared in `NAV_GROUPS` in the build. `404` and `index` are
special-cased; everything else becomes `/<name>/`.

## News and Notices

A post carries up to **three tags**, and **the first one is primary** — it is the
label the card and the post header print. Tagging a post `Notices` files it under
`/notices/` and takes it out of `/news/`; everything else is news. A post that is
genuinely both, like an admission notice, carries both tags.

**Every post keeps its `/news/<slug>/` address whatever it is tagged.** The
Notices page is a view over the same posts, not a second folder — the WordPress
redirect map in `site/.htaccess` points there, and so does every link already
shared to WhatsApp.

The sheet currently holds one category per post, which still works unchanged. The
build also accepts `"Admissions, Notices"` in that one cell, or a `tags` array, so
the portal's admin form can start offering several whenever it is ready.

### Paging and search

Both indexes show **six posts a page** and spill onto real files — `/news/2/`,
`/news/3/` — never onto script. A crawler that runs no JavaScript can still reach
the oldest post, which is the whole reason this site is generated. Change
`PER_PAGE` in the build to resize a page; the pages, the pager and the sitemap all
follow from it.

The **search box is the one script the site serves**. It searches every post in
that section rather than the six on screen, from a small JSON index built into the
page (about 3.5 KB for 29 posts). It ships `hidden` and reveals itself, so a
visitor without JavaScript sees no box rather than one that swallows what they
type — and the paged list behind it works either way. If the school ever has
thousands of posts, the embedded index is the thing to revisit.

## Faculty

`/faculty/` is generated from `content/faculty.json`, which the portal writes from
the staff records the results system already holds — the same route
`content/posts.json` takes. Nobody retypes the list each year.

**Publishing is deliberate, not automatic.** A new teacher must not appear on the
public website the moment somebody gives them a login; it is an action in the
admin panel. And only what a school prints in a prospectus is carried here — name,
title, subject, photograph. Never an email address, never a phone number.

```json
{
  "generated_at": "2026-09-05T00:00:00Z",
  "count": 2,
  "staff": [
    { "name": "...", "title": "Principal", "group": "Principal",
      "photo": "img/staff/whoever.webp" },
    { "name": "...", "title": "Teacher", "subject": "Mathematics",
      "group": "High School" }
  ]
}
```

`name` is the only required field. **`full_name` is printed when it is there and `name` when it is not** — `name` being the staffroom name the portal already holds, "Sir Siamtea" and the like. That is deliberate: the page can go live before every formal name has been typed, showing a real teacher under the name the school actually calls them rather than a blank or a placeholder. An honorific is dropped when working out the initials for a card with no photograph — "Sir Siamtea" is S, not SS. `photo` may be omitted — the card shows the
person's initials, so a half-photographed list looks deliberate rather than
broken. **`group` is decided by the portal, not inferred here**, because
`super_admin` describes what someone may do in the software, not what they do at
the school. Groups appear in the order set by `STAFF_GROUP_ORDER` in the build
(Principal, Vice Principal, High School, Higher Secondary, Office and support);
any other group still appears, after those, so a new one shows up rather than
vanishing because that list is out of date. A group of one or two gets a wider
card, so the Principal is not marooned in an empty row.

### Photographs

Two ways in, and neither is committed by hand.

**A teacher does it themselves.** Signing in to the portal asks once whether their
Google account picture may go on this page. Yes copies it here; "Not now" asks
again in 15 days; **"No thanks" is final** and an admin cannot publish over it.
Whatever they choose, the setting stays reachable from their portal home, so a
photograph can be changed or taken down at any time. Built in the portal repo —
`StaffPhotos.gs` and `js/staff-photo.js`; the reasoning is in its `CLAUDE.md`.

**An admin does it for them**, for the staff who never sign in — from the same
screen the staff list is managed on.

**Removal deletes the file, not just the reference.** A cleared `photo` cell
unpublishes the card while leaving the picture in this public repo at a guessable
address; refusing, removing and deleting a staff member all delete it.

For a batch of photographs the office already holds, `tools/staff-photos.py`
squares and converts a whole folder and prints the sheet values:

```
python tools/staff-photos.py --in "D:\staff pics"           # dry run
python tools/staff-photos.py --in "D:\staff pics" --write
```

Dry run first, always — it matches files to people by name, and a mismatch puts
one teacher's face on another teacher's card. Tall photographs are cropped from
**above** centre: a phone portrait has the head in the upper third, and a centred
square takes the chest. See the README in `img/staff/` for what to shoot.

`portal/publish-faculty.gs` is the script that writes this file. It belongs to
the portal's Apps Script project and is kept here because the shape it must
produce is defined by the build next door. It reads `Users`, joins each teacher
to the subjects assigned in `HS_Teachers` / `HSS_Teachers`, and commits through
the same helper `websitePublish_` already uses for posts.

## Deploying

Automatic on push to `main`. Five repository secrets are required:

`SSH_HOST` · `SSH_PORT` · `SSH_USER` · `SSH_PRIVATE_KEY` · `SSH_KNOWN_HOSTS`

`SSH_KNOWN_HOSTS` pins the server's host key. Without it the deploy would trust
any server claiming to be Hostinger — the exact weakness that ruled out FTPS,
whose certificate covers only Hostinger's own domains and never `baptisthss.in`.

### This deploys to the LIVE SITE

`DEPLOY_PATH` is `public_html`. **`rsync --delete` is pointed at it, so everything
there that is not in `dist/` is erased.** That is what makes a withdrawn post
actually disappear, and it is also why the path is guarded in the workflow before
rsync ever runs.

`DEPLOY_PATH`, `SITE_BASE_URL` and `IS_PREVIEW` are one setting in three lines and
must always be changed together. `SITE_BASE_URL` is baked into canonical URLs,
`og:image` and the sitemap; `IS_PREVIEW` decides whether `.htaccess` ships at all.

## The cutover, 5 September 2026

WordPress was replaced here on 5 September 2026. Kept for the next person who
wonders what happened to it, and because the reasoning still applies if the site
is ever moved again.

`public_html` is a symlink to `domains/baptisthss.in/public_html`; rsync writes
*through* it because the destination carries a trailing slash, so the symlink
itself survives. Other domains on the account live in sibling folders under
`domains/` and were never in reach.

What was checked first:

1. **`wp-content/uploads` was archived** outside `public_html`. It held the
   school's own photographs and PDFs — the one thing on that server that existed
   nowhere else. WordPress itself is reinstallable software and was simply erased.
2. **`public_html` was listed over SSH** and held nothing but WordPress and the
   preview folder. Probing from outside cannot prove a folder is absent, only that
   it is not served.
3. The WordPress **database was left in place**, orphaned but intact.

Two things the redirect map does *not* cover, both deliberate:

- **Old post images.** The migration renamed them and converted them to WebP, so
  `/wp-content/uploads/2024/08/img-2024...jpg` has no name to map to. Those URLs
  404 and Google re-crawls them away.
- **PDFs are covered**, by one rewrite rule rather than a list, because the
  migration kept their filenames. The rule requires the target to exist, so a PDF
  that was not carried over 404s directly instead of being sent to a second,
  emptier 404.

`.htaccess` had never once been served before this day — it is excluded from
preview deploys, because canonicalising to the apex from inside `/preview/` would
have thrown visitors back onto live WordPress. **It therefore went live untested.
A bad page is one bad page; a bad `.htaccess` is the whole site.**

After the first live deploy: home page, one post, one old dated URL redirecting, a
404, `/sitemap.xml`, and both canonical redirects (`http://` → `https://`,
`www.` → apex). **Then purge the Hostinger CDN** — the apex is an ALIAS to
`baptisthss.in.cdn.hstgr.net` and it caches for a week; until it is purged the
edge keeps serving WordPress, which looks exactly like a failed cutover.

Then submit `https://baptisthss.in/sitemap.xml` in Search Console. The old
`wp-sitemap.xml` 404s, which is correct.

Rolling back does not mean restoring WordPress: the whole site is in this repo, so
recovery is a fix and a push. Nothing about DNS, hosting or email changed —
`portal.baptisthss.in` and `photos.baptisthss.in` are GitHub Pages, and mail is
Google Workspace. None of them were ever in the path of this deploy.

## Still to do

- **Staff photographs** — `content/faculty.json` currently carries none, so every
  card on `/faculty/` shows initials. Working as designed, but the whole page.
- **Six staff names carry internal codes** — `Sir Davida HS`, `Sir Davida HSS` and
  four more. Those suffixes tell duplicate logins apart in the Users sheet and are
  not meant to be read by parents. Filling `full_name` for those six overrides it.
- **A proper favicon** — currently the full crest, which is heavier than it needs
  to be at 32px.
