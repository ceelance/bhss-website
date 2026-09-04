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
img/posts/              post pictures, uploaded by the portal
tools/build.mjs         the generator
tools/markdown.mjs      the post-body renderer
```

Adding a page: drop an HTML file in `site/pages/`, give it a `nav:` and an
`order:` in the header comment if it should appear in the menu. `404` and `index`
are special-cased; everything else becomes `/<name>/`.

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
back onto the live WordPress site.

## Still to do

- **The school's own words** for About, Academics, Admissions and Contact. The
  pages carry marked placeholders; those are for the office to replace, not for a
  website builder to invent.
- **`assets/og-default.png`** — 1200 × 675, shown when a post has no picture of
  its own and used as the site's share image.
- **A proper favicon** — currently the full crest, which is heavier than it needs
  to be at 32px.
- **The WordPress migration** — the export, the images, and the 301 map in
  `site/.htaccess`. Must be done while the old site is still up.
- **Faculty**, generated from the staff records rather than typed by hand.
