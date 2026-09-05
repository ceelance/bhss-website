/**
 * Build the site: templates + content -> dist/
 *
 * WHY A GENERATOR AT ALL, rather than a page that fetches its posts. WhatsApp and
 * Google read `og:image` and `og:title` out of a page's HTML WITHOUT running its
 * JavaScript. A self-fetching page therefore shows one identical link preview for
 * every post — which defeats the per-post thumbnail on the channel school news
 * actually travels by, and leaves the posts unindexed. So every post gets a real
 * file at news/<slug>/index.html with its own tags. That is the entire reason
 * publishing takes a minute instead of being instant.
 *
 * NO DEPENDENCIES, DELIBERATELY. This runs in a workflow holding an SSH key that
 * grants full access to the hosting account; every npm package in that job is a
 * path to that key. Node's standard library and ./markdown.mjs are enough.
 *
 * Run: node tools/build.mjs        (then open dist/index.html)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderMarkdown, escapeHtml, excerpt } from './markdown.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/**
 * A stamp of the stylesheet's CONTENT, appended to its URL.
 *
 * .htaccess holds CSS for a week, which is only safe if the address changes when
 * the file does — and it did not. The HTML asked for a bare `styles.css`, so a
 * returning visitor got today's markup dressed in last week's stylesheet: the
 * About menu fell back to a bare <details> widget and the notice board dropped
 * out of its column, because the rules for both were in the copy they did not
 * have. Nothing looked broken to anyone testing with an empty cache, which is
 * the worst kind of fault.
 *
 * Hashing the content rather than stamping the build means the URL changes when
 * the CSS changes and NOT on every deploy, so an unchanged stylesheet stays
 * cached.
 */
const CSS_VERSION = createHash('sha256')
  .update(readFileSync(join(ROOT, 'site', 'styles.css')))
  .digest('hex').slice(0, 8);

/**
 * The absolute address the finished site will live at. Used ONLY where a URL must
 * be absolute — og:image, canonical links, the sitemap — because a link preview is
 * fetched by a server that has no idea what page it came from.
 *
 * Everything else is written relative to the page (see `depthPrefix`), so the same
 * build works unchanged at the domain root and in the /preview/ subfolder we
 * deploy to while WordPress is still live.
 */
const BASE_URL = (process.env.SITE_BASE_URL || 'https://baptisthss.in').replace(/\/+$/, '');

const SCHOOL = 'Baptist Higher Secondary School';

// ---------------------------------------------------------------- helpers

/**
 * Fill {{name}} placeholders.
 *
 * split/join rather than String.replace, because a replacement containing `$&`
 * or `$1` — entirely possible in a post someone typed — would be interpreted as a
 * back-reference and silently corrupt the page.
 */
function fill(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split('{{' + key + '}}').join(value == null ? '' : String(value));
  }
  return out;
}

/** `.`, `..`, `../..` — how far this page sits below the site root. */
function depthPrefix(outPath) {
  const depth = outPath.split('/').length - 1;
  return depth === 0 ? '.' : Array(depth).fill('..').join('/');
}

/**
 * Pull the leading `<!-- key: value -->` block off a page file.
 * A tiny format on purpose: adding a YAML parser would mean adding a dependency,
 * and these files have four fields.
 */
function parsePage(source) {
  const match = source.match(/^\s*<!--([\s\S]*?)-->/);
  const meta = {};
  if (!match) return { meta, body: source };
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
    if (kv) meta[kv[1].toLowerCase()] = kv[2];
  }
  return { meta, body: source.slice(match[0].length) };
}

function writePage(outPath, html) {
  const full = join(DIST, outPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html, 'utf8');
}

/** A date a parent reads, not an ISO stamp. Falls back to the raw text. */
function humanDate(iso) {
  const d = new Date(String(iso || '') + (String(iso || '').length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return escapeHtml(iso || '');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Post bodies store asset paths relative to the site root (`img/posts/x.webp`,
 * `files/selected-list.pdf`), because that is what the admin panel uploads them
 * as. A post page lives two levels down, so those must be rewritten or every
 * picture 404s — the kind of break that only shows up on the deployed site,
 * never in a local check of the markdown.
 *
 * `files/` is here for the same reason `img/` is, and was missing: the two
 * migrated posts that link a selected-list PDF were pointing at
 * /news/<slug>/files/… and returning 404 on the deployed site.
 */
function rebaseAssets(html, prefix) {
  let out = html;
  for (const dir of ['img', 'files']) {
    out = out.split(`src="${dir}/`).join(`src="${prefix}/${dir}/`)
             .split(`href="${dir}/`).join(`href="${prefix}/${dir}/`);
  }
  return out;
}

// ---------------------------------------------------------------- inputs

const layout = readFileSync(join(ROOT, 'site', 'layout.html'), 'utf8');

const pageFiles = readdirSync(join(ROOT, 'site', 'pages'))
  .filter((f) => f.endsWith('.html'));

const pages = pageFiles.map((file) => {
  const { meta, body } = parsePage(readFileSync(join(ROOT, 'site', 'pages', file), 'utf8'));
  const name = file.replace(/\.html$/, '');
  return {
    name, meta, body,
    // index.html sits at the root; every other page gets a folder, so its address
    // is /about/ rather than /about.html — tidier, and it means the .html can be
    // renamed later without breaking a link anyone has shared.
    //
    // 404 is the exception: Apache's ErrorDocument points at a FILE, so it must
    // stay /404.html rather than becoming a directory.
    out: name === 'index' ? 'index.html'
       : name === '404'   ? '404.html'
       : `${name}/index.html`,
    url: name === 'index' ? '' : name === '404' ? '404.html' : `${name}/`,
    listed: name !== '404'
  };
});

let posts = [];
const postsPath = join(ROOT, 'content', 'posts.json');
if (existsSync(postsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(postsPath, 'utf8'));
    posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);
  } catch (err) {
    // A broken content file must FAIL the build rather than silently publishing a
    // site with no news on it — that would look like "nothing has happened lately"
    // rather than like a fault, and nobody would investigate.
    console.error('content/posts.json is not valid JSON:', err.message);
    process.exit(1);
  }
}
posts = posts.filter((p) => p && p.slug && p.title);
posts.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

/**
 * A post's tags.
 *
 * Must match WPOST_CATEGORIES in the portal's WebsitePosts.gs, or a post could
 * carry a tag the admin form cannot offer and an edit would silently change it.
 */
const CATEGORIES = ['News', 'Events', 'Notices', 'Achievements', 'Admissions'];

/**
 * THREE, and the FIRST ONE IS PRIMARY.
 *
 * A post genuinely can be two things — "Class IX Admission Notice" is an
 * admission and a notice — which is why one tag is not enough. But tags stop
 * meaning anything once a post carries most of them: tag something News AND
 * Notices AND Admissions and it appears everywhere, which is the same as having
 * no sections at all. Three leaves room for the real case and not for filing a
 * post under everything.
 *
 * The card and the post header print ONE label, so something has to decide which.
 * The first tag does, which is why order is not incidental.
 */
const MAX_TAGS = 3;

/**
 * Read tags off a post, in whichever shape the portal is writing this week.
 *
 * The sheet holds ONE category per post today, so that is what arrives; when the
 * admin form learns to send several, `tags: [...]` or "Admissions, Notices" in
 * the same cell both work here already. Accepting both means the website and the
 * portal do not have to change on the same afternoon.
 *
 * Unknown names are dropped rather than invented, and a post left with none is
 * News — the section a reader expects when nobody has said otherwise.
 */
const tagWarnings = [];
// Cached per post, because this is asked once per index, once per card and again
// per page — without which a post over the cap is reported five times over.
const tagCache = new WeakMap();
function postTags(post) {
  const cached = tagCache.get(post);
  if (cached) return cached;
  const raw = Array.isArray(post.tags) ? post.tags
            : Array.isArray(post.categories) ? post.categories
            : String(post.category || '').split(/[,;|\n]/);
  const out = [];
  for (const item of raw) {
    const name = CATEGORIES.find((c) => c.toLowerCase() === String(item).trim().toLowerCase());
    if (name && !out.includes(name)) out.push(name);
  }
  if (out.length > MAX_TAGS) {
    tagWarnings.push(`${post.slug}: ${out.length} tags, keeping the first ${MAX_TAGS} — ${out.join(', ')}`);
  }
  const tags = out.length ? out.slice(0, MAX_TAGS) : ['News'];
  tagCache.set(post, tags);
  return tags;
}

/** The one tag a card has room to print. */
function primaryTag(post) { return postTags(post)[0]; }

// The Notices page is a VIEW, not a folder: every post keeps its /news/<slug>/
// address whatever it is tagged. All 36 WordPress redirects in site/.htaccess
// point there, and so does every link already shared to WhatsApp.
const noticePosts = posts.filter((p) => postTags(p).includes('Notices'));
const newsPosts = posts.filter((p) => !postTags(p).includes('Notices'));

// ---------------------------------------------------------------- navigation

// News is generated rather than written as a page file, so it has no entry in
// site/pages to carry its nav label — it gets a synthetic one here. Without this
// the section people visit most would be missing from the menu.
const NEWS_NAV = { url: 'news/', meta: { nav: 'News', order: 7 } };

// The portal is a separate application on its own subdomain, so it has no page
// file here either — but it is the reason most people come, and burying it in the
// footer made them hunt. An absolute URL in the menu, sitting where the office
// asked for it: after Faculty, before Admissions.
const PORTAL_NAV = { url: 'https://portal.baptisthss.in/', meta: { nav: 'Portal', order: 5 } };

// Notices are the other half of the posts — filed by tag, not by folder.
const NOTICES_NAV = { url: 'notices/', meta: { nav: 'Notices', order: 8 } };

/**
 * Menus that hold pages rather than being one.
 *
 * A page joins one by declaring `group: About` in its header comment; its own
 * `order:` then places it INSIDE the menu, and the order here places the menu in
 * the bar. Grouping is what bought the room for Notices: School and Faculty were
 * two of the eight slots along the top, and are now one.
 *
 * A group is not a link. There is no /about/ page to send anyone to, and a menu
 * whose label goes somewhere makes the visitor guess whether the label or the
 * items are the destination.
 */
const NAV_GROUPS = { About: { order: 2 } };

const navTop = [];
const grouped = {};
for (const p of [...pages.filter((p) => p.meta.nav), NEWS_NAV, NOTICES_NAV, PORTAL_NAV]) {
  const group = p.meta.group;
  if (group && NAV_GROUPS[group]) (grouped[group] = grouped[group] || []).push(p);
  else navTop.push(p);
}
for (const [name, items] of Object.entries(grouped)) {
  navTop.push({ group: name, items: items.sort(byOrder), meta: { nav: name, order: NAV_GROUPS[name].order } });
}
function byOrder(a, b) { return Number(a.meta.order || 99) - Number(b.meta.order || 99); }
navTop.sort(byOrder);

function navLink(p, prefix, currentUrl, extra = '') {
  // An entry may point off the site, in which case it is already a whole URL and
  // must not be rebased — and no page here can ever be "current" for it.
  const offsite = /^https?:/i.test(p.url);
  const here = !offsite && p.url === currentUrl;
  const href = offsite ? p.url : `${prefix}/${p.url}`;
  return `<a href="${href}"${here ? ' aria-current="page"' : ''}${extra}>${escapeHtml(p.meta.nav)}</a>`;
}

function navHtml(prefix, currentUrl) {
  return navTop.map((p) => {
    if (!p.group) return navLink(p, prefix, currentUrl);
    // <details> rather than a hover menu built out of CSS tricks: it opens to a
    // click, a tap and the keyboard alike, and the browser keeps aria-expanded
    // right — none of which a div can claim without the JavaScript this site
    // does not load. Pointer users also get it on hover, from CSS.
    const open = p.items.some((i) => i.url === currentUrl) ? ' open' : '';
    return `<details class="nav-group"${open}>
          <summary>${escapeHtml(p.meta.nav)}</summary>
          <div class="nav-menu">
            ${p.items.map((i) => navLink(i, prefix, currentUrl)).join('\n            ')}
          </div>
        </details>`;
  }).join('\n        ');
}

// ---------------------------------------------------------------- render

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// JPEG, not PNG: it is a photograph, and as a 256-colour PNG it weighed 418 KB.
const DEFAULT_OG = '/assets/og-default.jpg';

/**
 * The stand-in pictures for a post that has none of its own.
 *
 * Every image dropped into assets/defaults/ joins the rotation — no code change,
 * no list to keep in step. Sorted by name so the order does not depend on what
 * the filesystem happens to return. With the folder absent or empty this is just
 * og-default.jpg, which is what the site used before there was a rotation.
 *
 * They should be 1200x675: the card and the hero are both 16:9, and a picture cut
 * to size here is never cropped by the browser.
 */
const DEFAULT_IMAGES = (() => {
  const dir = join(ROOT, 'assets', 'defaults');
  if (!existsSync(dir)) return [DEFAULT_OG];
  const found = readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map((f) => `/assets/defaults/${f}`);
  return found.length ? found : [DEFAULT_OG];
})();

/**
 * Which stand-in a post gets. Chosen by HASHING THE SLUG, not at random.
 *
 * A random pick would be re-rolled on every build: a notice already shared to
 * WhatsApp would show a different photograph the next time anyone opened the
 * link, and rsync would re-upload pages that had not actually changed. Hashing
 * the slug spreads the set across the news grid — which is the point — while
 * pinning each post to one picture for good.
 *
 * FNV-1a, which is eight lines and needs no dependency.
 */
function defaultImageFor(slug) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return DEFAULT_IMAGES[hash % DEFAULT_IMAGES.length];
}

function renderShell({ out, url, title, description, content, ogImage, ogType }) {
  const prefix = depthPrefix(out);
  // Fill the CONTENT first, then the layout. `fill` walks its keys in order and
  // content is inserted late, so a {{base}} written inside a page would otherwise
  // survive into the output as literal text — every internal link on that page
  // silently broken, and only on the deployed site.
  const body = fill(rebaseAssets(content, prefix), { base: prefix });
  const html = fill(layout, {
    base: prefix,
    lang: 'en',
    title: escapeHtml(title),
    fullTitle: escapeHtml(title === SCHOOL ? title : `${title} · ${SCHOOL}`),
    description: escapeHtml(description || ''),
    canonical: `${BASE_URL}/${url}`,
    ogImage: ogImage ? (/^https?:/.test(ogImage) ? ogImage : `${BASE_URL}/${ogImage.replace(/^\//, '')}`)
                     : `${BASE_URL}${DEFAULT_OG}`,
    ogType: ogType || 'website',
    school: SCHOOL,
    cssVersion: CSS_VERSION,
    nav: navHtml(prefix, url),
    content: body,
    year: new Date().getFullYear()
  });
  writePage(out, html);
}

// --- a card, shared by the news list and the "latest" strip on the home page
function postCard(post, prefix) {
  const fit = post.thumb_fit === 'whole' ? ' class="whole"' : '';
  const summary = post.summary || excerpt(post.body_md, 140);
  // A post with no picture of its own falls back to a school photograph rather
  // than to an empty panel, so the news grid reads as a wall of pictures. The
  // stand-in is already 16:9, so it needs no `whole` treatment.
  const src = post.thumb ? prefix + '/' + post.thumb
                         : prefix + defaultImageFor(post.slug);
  const thumb = `<img src="${escapeHtml(src)}" alt=""${post.thumb ? fit : ''} loading="lazy" width="1200" height="675">`;
  return `
      <a class="card" href="${prefix}/news/${encodeURIComponent(post.slug)}/">
        <div class="card-thumb">${thumb}</div>
        <div class="card-body">
          <p class="card-meta">${escapeHtml(primaryTag(post))} · ${humanDate(post.published_at)}</p>
          <h3>${escapeHtml(post.title)}</h3>
          <p class="card-summary">${escapeHtml(summary)}</p>
        </div>
      </a>`;
}

/**
 * One notice on the board: the date it was posted and what it says. No picture.
 *
 * A notice is read as a line in a list — is there anything new, and does it
 * concern me — and a stand-in photograph on a scholarship notice answers
 * neither, while costing the column the room to show a fifth notice.
 */
function noticeItem(post, prefix) {
  return `
        <li>
          <a href="${prefix}/news/${encodeURIComponent(post.slug)}/">
            <time datetime="${escapeHtml(post.published_at || '')}">${humanDate(post.published_at)}</time>
            <span>${escapeHtml(post.title)}</span>
          </a>
        </li>`;
}

// --- the static pages
//
// A page may include <!--LATEST_POSTS--> or <!--LATEST_NOTICES--> to have the
// newest of each dropped in. A tiny convention rather than a template language,
// and it keeps the home page in step with both indexes automatically.
//
// Two news cards rather than three: the third column of that row is the notice
// board now. Five notices fit beside two cards because they are lines, not cards.
const LATEST_ON_HOME = 2;
const NOTICES_ON_HOME = 5;
for (const page of pages) {
  let content = page.body;
  const prefix = depthPrefix(page.out);
  if (content.includes('<!--LATEST_POSTS-->')) {
    const latest = newsPosts.slice(0, LATEST_ON_HOME);
    content = content.split('<!--LATEST_POSTS-->').join(
      latest.length
        ? `<div class="cards">${latest.map((p) => postCard(p, prefix)).join('')}\n    </div>`
        : '<p class="empty">There are no posts yet.</p>');
  }
  if (content.includes('<!--LATEST_NOTICES-->')) {
    const latest = noticePosts.slice(0, NOTICES_ON_HOME);
    content = content.split('<!--LATEST_NOTICES-->').join(
      latest.length
        ? `<ul class="notice-list">${latest.map((p) => noticeItem(p, prefix)).join('')}\n      </ul>`
        : '<p class="empty">There are no notices at the moment.</p>');
  }
  renderShell({
    out: page.out,
    url: page.url,
    title: page.meta.title || page.name,
    description: page.meta.description,
    content
  });
}

// --- one page per post: the reason this is a generator
for (const post of posts) {
  const out = `news/${post.slug}/index.html`;
  const prefix = depthPrefix(out);
  const body = renderMarkdown(post.body_md || '');
  const summary = post.summary || excerpt(post.body_md, 180);
  const heroSrc = post.thumb ? `${prefix}/${post.thumb}`
                             : prefix + defaultImageFor(post.slug);
  const hero = `<img class="post-hero" src="${escapeHtml(heroSrc)}" alt="" width="1200" height="675">`;
  renderShell({
    out,
    url: `news/${post.slug}/`,
    title: post.title,
    description: summary,
    // The same stand-in the page shows, so the WhatsApp preview and the page a
    // reader then lands on carry the same picture.
    ogImage: post.thumb || defaultImageFor(post.slug),
    ogType: 'article',
    content: `
    <article class="post">
      <p class="post-meta">${postTags(post).map(escapeHtml).join(' &middot; ')} &middot; ${humanDate(post.published_at)}</p>
      <h1>${escapeHtml(post.title)}</h1>
      ${hero}
      <div class="post-body">
${body}
      </div>
      <p class="back">${postTags(post).includes('Notices')
        ? `<a href="${prefix}/notices/">← All notices</a>`
        : `<a href="${prefix}/news/">← All news</a>`}</p>
    </article>`
  });
}

// --- the two indexes. Same cards, split by tag: a notice is filed where someone
// looking for a notice will go, and does not push the school's news down the page.
for (const index of [
  { out: 'news/index.html', url: 'news/', title: 'News', list: newsPosts,
    description: `News, events and results from ${SCHOOL}.`,
    empty: 'There are no posts yet.' },
  { out: 'notices/index.html', url: 'notices/', title: 'Notices', list: noticePosts,
    description: `Notices and announcements from ${SCHOOL} — scholarships, admissions and examinations.`,
    empty: 'There are no notices at the moment.' }
]) {
  renderShell({
    out: index.out,
    url: index.url,
    title: index.title,
    description: index.description,
    content: `
    <h1>${index.title}</h1>
    ${index.list.length
      ? `<div class="cards">${index.list.map((p) => postCard(p, '..')).join('')}\n    </div>`
      : `<p class="empty">${index.empty}</p>`}`
  });
}

// ---------------------------------------------------------------- static files

// files/ holds documents linked from posts (the admission lists, the fee
// structure) — migrated off the old server so those links survive cutover.
for (const dir of ['assets', 'img', 'files']) {
  const from = join(ROOT, dir);
  // A README explaining a folder to whoever maintains it is not for the public —
  // assets/defaults/README.md would otherwise be served off the live domain.
  if (existsSync(from)) {
    cpSync(from, join(DIST, dir), {
      recursive: true,
      filter: (src) => !/README\.md$/i.test(src)
    });
  }
}
cpSync(join(ROOT, 'site', 'styles.css'), join(DIST, 'styles.css'));
if (existsSync(join(ROOT, 'site', '.htaccess'))) {
  cpSync(join(ROOT, 'site', '.htaccess'), join(DIST, '.htaccess'));
}

// A sitemap lists only the pages, not the assets — it is a hint to a crawler
// about what is worth indexing, and post pages are the point of it.
const urls = [
  ...pages.filter((p) => p.listed).map((p) => ({ loc: `${BASE_URL}/${p.url}` })),
  { loc: `${BASE_URL}/news/` },
  { loc: `${BASE_URL}/notices/` },
  ...posts.map((p) => ({ loc: `${BASE_URL}/news/${p.slug}/`, lastmod: p.published_at }))
];
writePage('sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${escapeHtml(u.loc)}</loc>` +
    (u.lastmod ? `<lastmod>${escapeHtml(u.lastmod)}</lastmod>` : '') + '</url>').join('\n') +
  '\n</urlset>\n');

writePage('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`);

console.log(`Built ${pages.length} pages + ${posts.length} posts ` +
            `(${newsPosts.length} news, ${noticePosts.length} notices) -> dist/`);
console.log(`Base URL: ${BASE_URL}`);
// Said out loud rather than swallowed: a post tagged past the cap still builds,
// but somebody chose tags that the site is quietly ignoring.
for (const warning of tagWarnings) console.warn(`  tags: ${warning}`);
