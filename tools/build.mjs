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
 * These five are the ones this build KNOWS: they are spelled here so a post
 * arrives with the canonical capitalisation whatever case the sheet holds, and
 * `Notices` in particular is load-bearing — it decides which posts are notices.
 * They mirror WPOST_CATEGORIES in the portal's WebsitePosts.gs.
 *
 * A NAME NOT ON THIS LIST IS ACCEPTED, not dropped. The admin panel can add a
 * category on the spot, and this file is next door in another repo — if an
 * unknown name were discarded, adding "Sports" in the panel would appear to work
 * and then quietly file every one of those posts under News, with nothing said.
 * Made-up names are still refused (see `normaliseTag`), so a typo cannot become
 * a public label; it is reported instead.
 */
const CATEGORIES = ['News', 'Events', 'Notices', 'Achievements', 'Admissions'];

/** A category is a label on a card, so it is held to the shape of one. */
const TAG_MAX_LEN = 24;
const TAG_SHAPE = /^[A-Za-z][A-Za-z0-9 &'’-]*$/;

/** Reported at the end of the build; see the summary at the bottom of this file. */
const tagWarnings = [];

function normaliseTag(raw) {
  const t = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const known = CATEGORIES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (known) return known;
  if (t.length > TAG_MAX_LEN || !TAG_SHAPE.test(t)) {
    tagWarnings.push(`dropped an unusable tag: ${JSON.stringify(t.slice(0, 40))}`);
    return null;
  }
  return t;
}

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
 *
 * Mirrored as WPOST_MAX_CATEGORIES in the portal's WebsitePosts.gs, where the
 * admin form enforces the same three and stores them in the order chosen.
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
 * A post left with no usable tag at all is News — the section a reader expects
 * when nobody has said otherwise.
 */
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
    const name = normaliseTag(item);
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

// ---------------------------------------------------------------- the staff

/**
 * The faculty, written by the portal exactly as posts.json is.
 *
 * The school's results system already knows every teacher's name and subject, so
 * this is generated from it rather than typed and re-typed each year — but it is
 * NOT automatic. A new teacher must not appear on the public website the moment
 * somebody gives them a login; publishing is a separate, deliberate action in the
 * admin panel.
 *
 * Only what a school prints in a prospectus is carried here — name, title,
 * subject, photograph. Never an email address, never a phone number. The portal
 * holds those and has a sign-in in front of them; this page is read by anyone.
 */
let staff = [];
const facultyPath = join(ROOT, 'content', 'faculty.json');
if (existsSync(facultyPath)) {
  try {
    const parsed = JSON.parse(readFileSync(facultyPath, 'utf8'));
    staff = Array.isArray(parsed) ? parsed : (parsed.staff || []);
  } catch (err) {
    console.error('content/faculty.json is not valid JSON:', err.message);
    process.exit(1);
  }
}
/**
 * What to print for a person.
 *
 * `full_name` when the office has entered one, otherwise the `name` the portal
 * already holds — which is the staffroom name, "Sir Siamtea" and the like. Not a
 * placeholder and not a blank: a real teacher under the name the school actually
 * calls them, until an admin fills the formal one in. That way the page can be
 * published before every full name has been typed.
 */
function staffName(person) {
  return String(person.full_name || person.name || '').trim();
}

staff = staff.filter((s) => s && staffName(s));

/**
 * The order the sections are shown in.
 *
 * The PORTAL decides which group a person is in — the website does not infer it
 * from an app role, because "super_admin" describes what someone may do in the
 * software, not what they do at the school. Anything the portal sends that is not
 * named here still appears, after these, in the order it first arrives: a new
 * group should show up rather than vanish because this list is out of date.
 */
/**
 * The order the school reads itself in, and it is not alphabetical: the
 * Principal, then the High School, then the Higher Secondary streams, then the
 * people who keep the place running.
 *
 * A group NOT on this list still appears — at the end, in the order it was met —
 * because a new department must never vanish from the public page just because
 * nobody edited this array. `Bus Staff` is listed before it exists for the same
 * reason: it costs nothing and puts the group in its right place the day it is
 * first used.
 *
 * A RENAME IN THE PORTAL SILENTLY DEMOTES A GROUP. "Principal" became
 * "Principals" in the staff sheet, and because the new spelling was on nobody's
 * list the school's own Principals dropped to the BOTTOM of the faculty page and
 * of the app — on both, at once, with nothing reporting it. Both spellings are
 * kept here for that reason: a name nothing is filed under costs nothing, and
 * removing one is how the bug comes back.
 *
 * THE APP NO LONGER KEEPS ITS OWN COPY OF THIS. app.json now carries the staff
 * already grouped in this order, and the app simply follows it — so the next
 * rename is a one-line change here rather than a change here AND a Play release.
 */
const STAFF_GROUP_ORDER = ['Principals', 'Principal', 'High School', 'Arts',
                           'Science', 'Commerce', 'HSS Language', 'Office Staff',
                           'Bus Staff'];

function staffGroups() {
  const seen = new Map();
  for (const person of staff) {
    const group = String(person.group || '').trim() || 'Staff';
    if (!seen.has(group)) seen.set(group, []);
    seen.get(group).push(person);
  }
  const rank = (g) => {
    const i = STAFF_GROUP_ORDER.indexOf(g);
    return i === -1 ? STAFF_GROUP_ORDER.length : i;
  };
  return [...seen.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

/**
 * Initials, for a card with no photograph.
 *
 * A staff list where some people have a picture and some do not is the normal
 * case, not a fault — so the gap gets a tile of its own rather than a broken
 * image or, worse, a stock face belonging to nobody.
 */
// MISS BELONGS HERE. Leaving it out was not a small omission: 27 of the 64 staff
// are "Miss <name>", so 42% of the page showed the M of Miss as a first initial
// — "Miss Ramliani" as MR rather than R. Every form of address the school
// actually uses has to be in this list, or the tile quietly libels the person's
// name. Add to it whenever a new one turns up.
const HONORIFICS = ['sir', 'madam', 'mdm', 'miss', 'mr', 'mrs', 'ms', 'dr',
                    'rev', 'upa', 'pu', 'pi'];
function initialsOf(name) {
  let words = String(name).replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)
    .filter((w) => /[a-z]/i.test(w));
  // "Sir Siamtea" is S, not SS, and "Upa C. Lalhmingmuana" is CL, not UL: an
  // honorific is how a person is addressed, not part of their name. Dropped only
  // when something is left to drop it from.
  if (words.length > 1 && HONORIFICS.includes(words[0].toLowerCase().replace(/\./g, ''))) {
    words = words.slice(1);
  }
  if (!words.length) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/**
 * The staffroom name — "Sir Siamtea", "Miss Kimkimi" — printed under the formal
 * one.
 *
 * BOTH LINES, and the same text on both while `full_name` is empty. A parent
 * reads the formal name; a student looking for their own teacher reads the name
 * the school actually says out loud, and the two are often nothing like each
 * other. Repeating it until the office fills in the formal name is deliberate and
 * temporary: the layout does not move when they do, and a card that is briefly
 * doubled is better than one whose shape changes under the reader.
 */
function staffNick(person) {
  return String(person.name || '').trim();
}

function staffCard(person, prefix) {
  const name = staffName(person);
  const nick = staffNick(person);
  const photo = String(person.photo || '').trim();
  const face = photo
    ? `<img src="${escapeHtml(prefix + '/' + photo)}" alt="" loading="lazy" width="400" height="400">`
    : `<span class="staff-initials" aria-hidden="true">${escapeHtml(initialsOf(name))}</span>`;
  const title = String(person.title || '').trim();
  const subject = String(person.subject || '').trim();
  return `
        <li class="staff-card">
          <div class="staff-face">${face}</div>
          <div class="staff-body">
            <h3>${escapeHtml(name)}</h3>
            ${nick ? `<p class="staff-nick">${escapeHtml(nick)}</p>` : ''}
            ${title ? `<p class="staff-title">${escapeHtml(title)}</p>` : ''}
            ${subject ? `<p class="staff-subject">${escapeHtml(subject)}</p>` : ''}
          </div>
        </li>`;
}

/** A group name → the id its section carries, for the jump links above. */
function groupSlug(group) {
  return 'g-' + String(group).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function facultyHtml(prefix) {
  const groups = staffGroups();
  if (!groups.length) {
    return `<p class="empty">The staff list has not been published yet.</p>`;
  }

  // A STRIP OF JUMP LINKS, and it sticks to the top as you scroll.
  //
  // Sixty-seven people down a phone screen is a long way to travel to find the
  // Commerce department, and the browser's own find-in-page is not something a
  // parent will reach for. The strip scrolls sideways when the names outgrow the
  // width rather than wrapping to two rows, so its height never changes and the
  // page beneath it never jumps.
  //
  // Plain anchors: no JavaScript, and each one is a real address a person can
  // send to somebody else.
  const jump = `
    <nav class="staff-jump" aria-label="Departments">
      <div class="staff-jump-inner">${groups.map(([group]) =>
        `<a href="#${groupSlug(group)}">${escapeHtml(group)}</a>`).join('')}
      </div>
    </nav>`;

  return jump + '\n' + groups.map(([group, people]) => {
    // A group of one or two — the Principal, usually — laid out in the same grid
    // as thirty teachers leaves a lone card marooned in an empty row, which reads
    // as a mistake rather than as the top of the school. Those get a wider card
    // that fills its line on purpose.
    const lead = people.length <= 2 ? ' is-lead' : '';
    return `
    <section class="staff-group" id="${groupSlug(group)}">
      <h2>${escapeHtml(group)}</h2>
      <ul class="staff-grid${lead}">${people.map((p) => staffCard(p, prefix)).join('')}
      </ul>
    </section>`;
  }).join('\n');
}

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
    // MARKED, NOT OPENED. This used to render `open` on the page the menu holds,
    // which meant every visit to School or Faculty — and every refresh of one —
    // arrived with a panel already hanging over the page, and closing it did not
    // stick. The job that attribute was doing is "show them where they are", and
    // a highlighted label does that without the panel: the same cue the top-level
    // links get from aria-current, moved up to the summary because the link
    // carrying it is inside a menu nobody has opened yet.
    const here = p.items.some((i) => i.url === currentUrl) ? ' is-current' : '';
    return `<details class="nav-group${here}">
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

/**
 * The running band of RECENT notices across the top of the home page.
 *
 * Different from the notice board below it, which is the five newest whatever
 * their age: this is only what is still current, so an empty band means there is
 * genuinely nothing on at the moment rather than that nothing has been posted in
 * a year.
 *
 * WHY IT ALSO EXPIRES IN THE BROWSER. The cutoff is worked out at BUILD time, and
 * the site is only rebuilt when somebody publishes — so a quiet fortnight would
 * leave a three-week-old notice scrolling across the home page as though it were
 * this morning's. The few lines of script at the end of this function drop the
 * ones whose week is up on the way in, and remove the whole band if that empties
 * it. It is an enhancement in the same sense as the menu script: without it the
 * band still renders, still links and still scrolls, it is just as fresh as the
 * last deploy.
 */
const TICKER_DAYS = 7;
const TICKER_MAX = 8;

function noticeTickerHtml(prefix) {
  const cutoff = new Date(Date.now() - TICKER_DAYS * 86400000).toISOString().slice(0, 10);
  const fresh = noticePosts
    .filter((p) => String(p.published_at || '') >= cutoff)
    .slice(0, TICKER_MAX);
  if (!fresh.length) return '';

  const item = (p, clone) => {
    // The day this one stops being current, for the script below.
    const until = new Date(new Date(p.published_at + 'T12:00:00').getTime() +
                           TICKER_DAYS * 86400000).toISOString().slice(0, 10);
    return `
          <li data-until="${until}"${clone ? ' aria-hidden="true"' : ''}>
            <a href="${prefix}/news/${encodeURIComponent(p.slug)}/"${clone ? ' tabindex="-1"' : ''}>
              <time datetime="${escapeHtml(p.published_at || '')}">${humanDate(p.published_at)}</time>
              <span>${escapeHtml(p.title)}</span>
            </a>
          </li>`;
  };

  // The list is laid out TWICE and the track slides exactly half its width, which
  // is what makes the loop seamless — at the moment it snaps back, the copy is
  // sitting precisely where the original was. The copy is hidden from screen
  // readers and taken out of the tab order, or every notice would be announced
  // and tabbed through twice.
  const once = fresh.map((p) => item(p, false)).join('');
  const twice = fresh.map((p) => item(p, true)).join('');

  // Constant speed regardless of how many notices there are: a band of one would
  // otherwise crawl and a band of eight would race. Roughly 70px a second over an
  // estimate of the rendered width, which does not have to be exact — it only
  // sets the pace.
  const width = fresh.reduce((n, p) => n + String(p.title).length * 8.5 + 150, 0);
  const seconds = Math.max(18, Math.round(width / 70));

  return `<div class="ticker" id="notice-ticker" role="region" aria-label="Recent notices">
      <p class="ticker-label">Notices</p>
      <div class="ticker-viewport">
        <ul class="ticker-track" style="--ticker-seconds:${seconds}s">${once}${twice}
        </ul>
      </div>
    </div>
    <script>
    (function () {
      var band = document.getElementById('notice-ticker');
      if (!band) return;
      // Local midnight as yyyy-MM-dd. Compared as strings, which is exactly
      // right for ISO dates and needs no date parsing at all.
      var d = new Date();
      var today = d.getFullYear() + '-' +
                  String(d.getMonth() + 1).padStart(2, '0') + '-' +
                  String(d.getDate()).padStart(2, '0');
      var items = band.querySelectorAll('[data-until]');
      var kept = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].getAttribute('data-until') < today) items[i].remove();
        else kept++;
      }
      // Every notice expired: the band would otherwise sit there empty.
      if (!kept) band.remove();
    })();
    </script>`;
}

// --- the static pages
//
// A page may include <!--LATEST_POSTS-->, <!--LATEST_NOTICES--> or
// <!--NOTICE_TICKER--> to have the newest of each dropped in. A tiny convention
// rather than a template language, and it keeps the home page in step with both
// indexes automatically.
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
  if (content.includes('<!--NOTICE_TICKER-->')) {
    content = content.split('<!--NOTICE_TICKER-->').join(noticeTickerHtml(prefix));
  }
  if (content.includes('<!--FACULTY-->')) {
    content = content.split('<!--FACULTY-->').join(facultyHtml(prefix));
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

/**
 * How many posts an index page shows before it spills onto the next.
 *
 * Paged as REAL FILES — /news/, /news/2/, /news/3/ — not by hiding rows with
 * script. Every post stays in someone's HTML, which is the whole reason this is
 * a generator: a crawler that does not run JavaScript can still reach page four.
 */
const PER_PAGE = 6;

// Filled as the indexes are written, so the sitemap lists page 2 onwards too —
// otherwise a crawler's only route to an older post is following Older link by
// link, and the deeper pages read as orphans.
const indexPageUrls = [];

/** [1,2,3,4,5,6,7] at 6 -> [[1..6],[7]]. Always at least one page, even if empty. */
function paginate(list, perPage) {
  const out = [];
  for (let i = 0; i < list.length; i += perPage) out.push(list.slice(i, i + perPage));
  return out.length ? out : [[]];
}

/**
 * Newer/older rather than previous/next, and numbers in between.
 *
 * "Previous" is ambiguous on a list that runs newest-first — previous in the
 * list, or earlier in time? Newer and older cannot be read two ways.
 */
function pagerHtml(base, pageNo, total, prefix) {
  if (total < 2) return '';
  const href = (n) => (n === 1 ? `${prefix}/${base}/` : `${prefix}/${base}/${n}/`);
  const parts = [];
  parts.push(pageNo > 1
    ? `<a class="pager-step" rel="prev" href="${href(pageNo - 1)}">&larr; Newer</a>`
    : `<span class="pager-step is-off">&larr; Newer</span>`);
  for (let n = 1; n <= total; n++) {
    parts.push(n === pageNo
      ? `<span class="pager-n is-here" aria-current="page">${n}</span>`
      : `<a class="pager-n" href="${href(n)}">${n}</a>`);
  }
  parts.push(pageNo < total
    ? `<a class="pager-step" rel="next" href="${href(pageNo + 1)}">Older &rarr;</a>`
    : `<span class="pager-step is-off">Older &rarr;</span>`);
  return `
    <nav class="pager" aria-label="Pagination">
      ${parts.join('\n      ')}
    </nav>`;
}

/**
 * The search box, and the whole section's posts as JSON for it to read.
 *
 * SHIPPED HIDDEN AND REVEALED BY THE SCRIPT. Search is the one thing here that
 * cannot work without JavaScript on static hosting, and a box that swallows what
 * you type is worse than no box — so a visitor without it never sees one, and
 * everything else on the page works as it always did.
 *
 * The index is this section's posts only, and it searches ALL of them rather than
 * the six on screen, which is the point of having it. At 36 posts it is a few
 * kilobytes; if the school ever has thousands, this is the thing to revisit.
 *
 * `<` is escaped so a post titled with a `</script>` cannot close the tag it is
 * sitting inside.
 */
function searchHtml(list, label, prefix) {
  const index = list.map((p) => ({
    // Built against this page's own depth. A bare `<slug>/` would resolve to
    // /news/2/<slug>/ from page two, and to /notices/<slug>/ from the notice
    // index — neither of which exists. Every post lives under /news/.
    u: `${prefix}/news/${encodeURIComponent(p.slug)}/`,
    t: p.title,
    d: humanDate(p.published_at),
    g: postTags(p).join(' · ')
  }));
  const json = JSON.stringify(index).replace(/</g, '\\u003c');
  return `
    <form class="search" role="search" hidden>
      <label for="q">Search ${escapeHtml(label)}</label>
      <input id="q" type="search" autocomplete="off" spellcheck="false"
             placeholder="Type a title, a year, a word&hellip;">
    </form>
    <script type="application/json" id="search-index">${json}</script>`;
}

/**
 * The search itself. Inline, and the only script the site serves.
 *
 * Written out rather than pulled in: the deploy workflow holds an SSH key with
 * full access to the hosting account, and the rule that keeps npm out of the
 * build is the same rule that keeps a search library out of the page.
 *
 * It reveals the form as its first act, so the box exists only where it works.
 */
const SEARCH_SCRIPT = `
    <script>
    (function () {
      var tag = document.getElementById('search-index');
      var form = document.querySelector('.search');
      var input = document.getElementById('q');
      var browse = document.getElementById('browse');
      var results = document.getElementById('results');
      if (!tag || !form || !input || !browse || !results) return;
      var items;
      try { items = JSON.parse(tag.textContent); } catch (e) { return; }

      form.hidden = false;
      form.addEventListener('submit', function (e) { e.preventDefault(); });

      function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
      }

      function draw() {
        var q = input.value.trim().toLowerCase();
        if (!q) {
          results.hidden = true; results.innerHTML = ''; browse.hidden = false; return;
        }
        browse.hidden = true; results.hidden = false;
        var hits = items.filter(function (it) {
          return (it.t + ' ' + it.d + ' ' + it.g).toLowerCase().indexOf(q) !== -1;
        });
        if (!hits.length) {
          results.innerHTML = '<p class="empty">Nothing matches that.</p>';
          return;
        }
        results.innerHTML =
          '<p class="search-count">' + hits.length +
            (hits.length === 1 ? ' result' : ' results') + '</p>' +
          '<ul class="notice-list result-list">' + hits.map(function (it) {
            return '<li><a href="' + esc(it.u) + '">' +
                   '<time>' + esc(it.d) + '</time>' +
                   '<span>' + esc(it.t) + '</span></a></li>';
          }).join('') + '</ul>';
      }

      input.addEventListener('input', draw);
      // A search typed, then reached again with the back button: browsers restore
      // the typed value but fire no input event, so the page would show the
      // browse list under a box that still reads as a search.
      draw();
    })();
    </script>`;

// --- the two indexes. Same cards, split by tag: a notice is filed where someone
// looking for a notice will go, and does not push the school's news down the page.
for (const index of [
  { base: 'news', title: 'News', list: newsPosts, label: 'news',
    description: `News, events and results from ${SCHOOL}.`,
    empty: 'There are no posts yet.' },
  { base: 'notices', title: 'Notices', list: noticePosts, label: 'notices',
    description: `Notices and announcements from ${SCHOOL} — scholarships, admissions and examinations.`,
    empty: 'There are no notices at the moment.' }
]) {
  const chunks = paginate(index.list, PER_PAGE);
  // /news/2/ is a page of the index; /news/<slug>/ is a post. They share one
  // namespace, so a post slugged "2" would be overwritten by page two without a
  // word said. No post is numbered today; this is here for the day one is.
  for (const p of index.list) {
    if (/^\d+$/.test(p.slug)) {
      console.error(`content: post slug "${p.slug}" collides with an index page ` +
                    `of the same number — rename it in the sheet.`);
      process.exit(1);
    }
  }
  chunks.forEach((chunk, i) => {
    const pageNo = i + 1;
    const out = pageNo === 1 ? `${index.base}/index.html` : `${index.base}/${pageNo}/index.html`;
    const url = pageNo === 1 ? `${index.base}/` : `${index.base}/${pageNo}/`;
    const prefix = depthPrefix(out);
    renderShell({
      out,
      url,
      title: pageNo === 1 ? index.title : `${index.title} — page ${pageNo}`,
      // Page two onwards says so, so a search result for it is not a second entry
      // wearing the same description as the first.
      description: pageNo === 1 ? index.description
                                : `${index.description} Page ${pageNo} of ${chunks.length}.`,
      content: `
    <h1>${index.title}</h1>
    ${index.list.length ? searchHtml(index.list, index.label, prefix) : ''}
    <div id="browse">
    ${chunk.length
      ? `<div class="cards">${chunk.map((p) => postCard(p, prefix)).join('')}\n    </div>`
      : `<p class="empty">${index.empty}</p>`}
    ${pagerHtml(index.base, pageNo, chunks.length, prefix)}
    </div>
    <div id="results" hidden></div>${index.list.length ? SEARCH_SCRIPT : ''}`
    });
  });
  indexPageUrls.push(...chunks.map((_, i) =>
    i === 0 ? `${index.base}/` : `${index.base}/${i + 1}/`));
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
  ...indexPageUrls.map((u) => ({ loc: `${BASE_URL}/${u}` })),
  ...posts.map((p) => ({ loc: `${BASE_URL}/news/${p.slug}/`, lastmod: p.published_at }))
];
writePage('sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${escapeHtml(u.loc)}</loc>` +
    (u.lastmod ? `<lastmod>${escapeHtml(u.lastmod)}</lastmod>` : '') + '</url>').join('\n') +
  '\n</urlset>\n');

writePage('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`);

/**
 * app.json — what the Android app reads.
 *
 * WHY IT COMES FROM HERE AND NOT FROM APPS SCRIPT. The app needs the same news
 * and the same faculty this site already publishes, and there are three reasons
 * to serve it off the same deploy rather than through the portal's backend:
 * it needs NO SIGN-IN, which matters because most of the people opening the app
 * are parents and guests; it costs no Apps Script quota, which is a real ceiling
 * on release day; and it is a static file behind the same CDN, so a thousand
 * phones opening it at once is free.
 *
 * It is DERIVED, never authored — every field here is already on a page this
 * build wrote, so the app cannot show anything the website is not showing.
 *
 * Absolute URLs on purpose: the app has no notion of this site's layout, and a
 * relative path would have to be resolved by every reader of this file.
 */
const APP_FEED_POSTS = 40;
const appFeed = {
  generated_at: new Date().toISOString(),
  // Bumped only if the SHAPE changes incompatibly, so an old build can tell.
  schema: 1,
  site: BASE_URL,
  news: posts.slice(0, APP_FEED_POSTS).map((p) => ({
    slug: p.slug,
    title: p.title,
    summary: p.summary || excerpt(p.body_md, 180),
    tags: postTags(p),
    published_at: p.published_at || '',
    // Already absolute and already the size the cards want.
    image: p.thumb ? `${BASE_URL}/${p.thumb}` : `${BASE_URL}${defaultImageFor(p.slug)}`,
    url: `${BASE_URL}/news/${p.slug}/`
  })),
  // The faculty page's own list, minus nothing — it carries prospectus facts
  // only to begin with (name, title, subject, photograph), which is exactly
  // what may leave the building.
  //
  // ALREADY IN THE PAGE'S ORDER, group by group. It used to be sent in whatever
  // order the sheet happened to be in, which left the app to sort it — so the
  // app kept its own copy of STAFF_GROUP_ORDER, and the day the portal renamed
  // "Principal" to "Principals" BOTH lists went stale and the Principals fell to
  // the bottom of the website and the app together. Sending it ordered means
  // there is one list, in one file, and a rename never needs a Play release.
  staff: staffGroups().reduce((all, [, people]) => all.concat(people), []).map((s) => ({
    name: s.name || '',
    full_name: s.full_name || '',
    title: s.title || '',
    subject: s.subject || '',
    group: s.group || '',
    photo: s.photo ? `${BASE_URL}/${s.photo}` : ''
  })),
  links: {
    website: `${BASE_URL}/`,
    news: `${BASE_URL}/news/`,
    notices: `${BASE_URL}/notices/`,
    faculty: `${BASE_URL}/faculty/`,
    admissions: `${BASE_URL}/admissions/`,
    downloads: `${BASE_URL}/downloads/`,
    contact: `${BASE_URL}/contact/`
  }
};
writePage('app.json', JSON.stringify(appFeed));

console.log(`Built ${pages.length} pages + ${posts.length} posts ` +
            `(${newsPosts.length} news, ${noticePosts.length} notices) -> dist/`);
console.log(`Base URL: ${BASE_URL}`);
// Said out loud rather than swallowed: a post tagged past the cap still builds,
// but somebody chose tags that the site is quietly ignoring.
for (const warning of tagWarnings) console.warn(`  tags: ${warning}`);
