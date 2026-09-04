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
import { renderMarkdown, escapeHtml, excerpt } from './markdown.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

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
 * Post bodies store image paths relative to the site root (`img/posts/x.webp`),
 * because that is what the admin panel uploads them as. A post page lives two
 * levels down, so those must be rewritten or every picture 404s — the kind of
 * break that only shows up on the deployed site, never in a local check of the
 * markdown.
 */
function rebaseAssets(html, prefix) {
  return html.split('src="img/').join(`src="${prefix}/img/`)
             .split('href="img/').join(`href="${prefix}/img/`);
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

// ---------------------------------------------------------------- navigation

// News is generated rather than written as a page file, so it has no entry in
// site/pages to carry its nav label — it gets a synthetic one here. Without this
// the section people visit most would be missing from the menu.
const NEWS_NAV = { url: 'news/', meta: { nav: 'News', order: 6 } };

const navPages = [...pages.filter((p) => p.meta.nav), NEWS_NAV]
  .sort((a, b) => Number(a.meta.order || 99) - Number(b.meta.order || 99));

function navHtml(prefix, currentUrl) {
  return navPages.map((p) => {
    const here = p.url === currentUrl;
    return `<a href="${prefix}/${p.url}"${here ? ' aria-current="page"' : ''}>${escapeHtml(p.meta.nav)}</a>`;
  }).join('\n        ');
}

// ---------------------------------------------------------------- render

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// JPEG, not PNG: it is a photograph, and as a 256-colour PNG it weighed 418 KB.
const DEFAULT_OG = '/assets/og-default.jpg';

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
  // A post with no picture gets a tinted panel, not an <img> pointing at a file
  // that may not exist — a broken-image icon on every card reads as a fault,
  // whereas an empty panel reads as a post that simply has no photograph.
  const thumb = post.thumb
    ? `<img src="${escapeHtml(prefix + '/' + post.thumb)}" alt=""${fit} loading="lazy" width="1200" height="675">`
    : '<span class="card-noimage" aria-hidden="true">BHSS</span>';
  return `
      <a class="card" href="${prefix}/news/${encodeURIComponent(post.slug)}/">
        <div class="card-thumb">${thumb}</div>
        <div class="card-body">
          <p class="card-meta">${escapeHtml(post.category || 'News')} · ${humanDate(post.published_at)}</p>
          <h3>${escapeHtml(post.title)}</h3>
          <p class="card-summary">${escapeHtml(summary)}</p>
        </div>
      </a>`;
}

// --- the static pages
//
// A page may include the marker <!--LATEST_POSTS--> to have the newest few cards
// dropped in. A tiny convention rather than a template language, and it keeps the
// home page's news strip in step with the news index automatically.
const LATEST_ON_HOME = 3;
for (const page of pages) {
  let content = page.body;
  if (content.includes('<!--LATEST_POSTS-->')) {
    const prefix = depthPrefix(page.out);
    const latest = posts.slice(0, LATEST_ON_HOME);
    content = content.split('<!--LATEST_POSTS-->').join(
      latest.length
        ? `<div class="cards">${latest.map((p) => postCard(p, prefix)).join('')}\n    </div>`
        : '<p class="empty">There are no posts yet.</p>');
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
  const hero = post.thumb
    ? `<img class="post-hero" src="${prefix}/${escapeHtml(post.thumb)}" alt="" width="1200" height="675">`
    : '';
  renderShell({
    out,
    url: `news/${post.slug}/`,
    title: post.title,
    description: summary,
    ogImage: post.thumb || '',
    ogType: 'article',
    content: `
    <article class="post">
      <p class="post-meta">${escapeHtml(post.category || 'News')} · ${humanDate(post.published_at)}</p>
      <h1>${escapeHtml(post.title)}</h1>
      ${hero}
      <div class="post-body">
${body}
      </div>
      <p class="back"><a href="${prefix}/news/">← All news</a></p>
    </article>`
  });
}

// --- the news index
renderShell({
  out: 'news/index.html',
  url: 'news/',
  title: 'News',
  description: `Announcements, events and results from ${SCHOOL}.`,
  content: `
    <h1>News</h1>
    ${posts.length
      ? `<div class="cards">${posts.map((p) => postCard(p, '..')).join('')}\n    </div>`
      : '<p class="empty">There are no posts yet.</p>'}`
});

// ---------------------------------------------------------------- static files

// files/ holds documents linked from posts (the admission lists, the fee
// structure) — migrated off the old server so those links survive cutover.
for (const dir of ['assets', 'img', 'files']) {
  const from = join(ROOT, dir);
  if (existsSync(from)) cpSync(from, join(DIST, dir), { recursive: true });
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
  ...posts.map((p) => ({ loc: `${BASE_URL}/news/${p.slug}/`, lastmod: p.published_at }))
];
writePage('sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${escapeHtml(u.loc)}</loc>` +
    (u.lastmod ? `<lastmod>${escapeHtml(u.lastmod)}</lastmod>` : '') + '</url>').join('\n') +
  '\n</urlset>\n');

writePage('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`);

console.log(`Built ${pages.length} pages + ${posts.length} posts -> dist/`);
console.log(`Base URL: ${BASE_URL}`);
