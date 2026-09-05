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
assets/                 crest, favicon, default share image
assets/defaults/        stand-in pictures for a post with none of its own
img/posts/              post pictures, uploaded by the portal
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

Photographs go in `img/staff/` — see the README there.

## Deploying

Automatic on push to `main`. Five repository secrets are required:

`SSH_HOST` · `SSH_PORT` · `SSH_USER` · `SSH_PRIVATE_KEY` · `SSH_KNOWN_HOSTS`

`SSH_KNOWN_HOSTS` pins the server's host key. Without it the deploy would trust
any server claiming to be Hostinger — the exact weakness that ruled out FTPS,
whose certificate covers only Hostinger's own domains and never `baptisthss.in`.

### Currently deploying to a PREVIEW folder

`DEPLOY_PATH` in the workflow is `public_html/preview`, because WordPress is still
live in `public_html`. At cutover, change `DEPLOY_PATH`, `SITE_BASE_URL` and
`IS_PREVIEW` together — they are commented in the workflow.

`.htaccess` is deliberately not deployed while previewing: it canonicalises every
request to the apex, which from inside `/preview/` would bounce visitors straight
back onto the live WordPress site. **A consequence worth stating plainly: it has
therefore never been served, and goes live untested. A bad page is one bad page;
a bad `.htaccess` is the whole site.** Cut over when someone can watch it.

## Cutting over

**`rsync --delete` is pointed at `public_html`, so everything there that is not in
`dist/` is erased** — WordPress, and anything else living in that folder. `/preview`
is inside it and goes too, which is deliberate: otherwise a duplicate of the site
stays up competing with itself in search.

Before:

1. **Take a fresh backup of `public_html`, download it, and open it.** A backup
   nobody has opened is a hope, not a backup.
2. **List `public_html` over SSH** and confirm nothing but WordPress is in it.
   Probing from outside cannot prove a folder is absent — only that it is not
   served.
3. Finish or unlist **Faculty**; it is the last page carrying placeholder text.

The change itself is three lines in `.github/workflows/deploy.yml`, commented
there: `DEPLOY_PATH: public_html`, `SITE_BASE_URL: https://baptisthss.in`,
`IS_PREVIEW: 'false'`. Push, and watch the Action.

Immediately after: check the home page, one post, one old dated URL redirecting, a
404, and `/sitemap.xml`. **Then purge the Hostinger CDN** — it caches for a week,
and until it is purged the edge keeps serving WordPress, which looks exactly like
a failed cutover.

Then submit `https://baptisthss.in/sitemap.xml` in Search Console. The old
`wp-sitemap.xml` will 404, which is correct.

Rolling back is restoring that backup. Nothing about DNS or hosting changes.

## Still to do

- **Faculty**, generated from the staff records rather than typed by hand. It is
  the one page still carrying "to be supplied by the office".
- **A proper favicon** — currently the full crest, which is heavier than it needs
  to be at 32px.
