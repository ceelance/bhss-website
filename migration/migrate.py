#!/usr/bin/env python3
"""
One-off migration: WordPress export -> content/posts.json + img/posts/ + a 301 map.

THROWAWAY, and deliberately not part of the build. It runs once against the
backup, its output is reviewed by hand, and then it is only of historical
interest. It is the one thing here that needs a dependency (Pillow, for the
images) — which is fine precisely because it never runs in CI, where the
dependency-free rule exists to protect the deploy key.

    python migration/migrate.py

Inputs are the Hostinger backup taken on 2026-09-04; edit BACKUP below if it
moves. The uploads are read STRAIGHT OUT OF THE ZIP — 155 MB of originals that
nothing afterwards needs, so there is no reason to unpack them onto disk.

What it will NOT carry across, stated plainly: Elementor layouts, sliders,
shortcodes and embeds have no equivalent in a markdown post and are dropped,
with a warning per post so nothing disappears silently. Ordinary posts —
headings, paragraphs, images, links, lists — come across faithfully.
"""

import html
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

from PIL import Image

BACKUP = Path(r"D:\MY STUFF\BHSS Related\NEW RESULT SYSTEM\Old hostinger wp backup 05.09.2026")
XML = BACKUP / "wpadmin tools all content backup" / "bhssserkawn.WordPress.2026-09-04.xml"
UPLOADS_ZIP = BACKUP / "public_html wpcontent uploads" / "uploads.zip"

REPO = Path(__file__).resolve().parent.parent
IMG_DIR = REPO / "img" / "posts"
OUT_JSON = REPO / "content" / "posts.json"
OUT_REDIRECTS = REPO / "migration" / "redirects.txt"
OUT_TSV = REPO / "migration" / "posts.tsv"

# Must match WPOST_CATEGORIES in WebsitePosts.gs, or a migrated post would carry
# a category the admin form cannot offer and an edit would silently change it.
CATEGORIES = ["News", "Events", "Notices", "Achievements", "Admissions"]
CATEGORY_MAP = {
    "general": "News", "news": "News", "uncategorized": "News",
    "event": "Events", "events": "Events", "sports": "Events",
    "notice": "Notices", "notices": "Notices", "announcement": "Notices",
    "result": "Notices", "results": "Notices", "exam": "Notices",
    "achievement": "Achievements", "achievements": "Achievements",
    "admission": "Admissions", "admissions": "Admissions",
}

BODY_MAX = 1600          # in-post image, longest side
THUMB_W, THUMB_H = 1200, 675
QUALITY = 82

# The old theme set a generic house image as the featured image on most posts.
# Carrying it across would put the SAME picture on nearly every card, which is
# worse than none — the site's card design draws a tinted panel when a post has
# no picture, and that at least reads as "no photograph" rather than as a mistake.
PLACEHOLDER_FEATURED = ("posts-default",)

# Files that are linked from a post rather than shown in it. They live on the old
# server, so a migrated post linking to them would 404 the day WordPress goes.
FILE_DIR = REPO / "files"
FILE_EXT = (".pdf", ".doc", ".docx", ".xls", ".xlsx")

# Block-level markup Elementor and the theme emit that has no markdown meaning.
LOST_MARKERS = [
    ("elementor", "an Elementor layout"),
    ("wp:shortcode", "a shortcode"),
    ("wp:embed", "an embed"),
    ("wp-block-buttons", "a button block"),
    ("wp-block-columns", "a multi-column layout"),
    ("wp-block-table", "a table"),
]


# ----------------------------------------------------------------- HTML -> md

class ToMarkdown(HTMLParser):
    """
    Gutenberg HTML -> the markdown subset the site renders.

    Deliberately small: it understands the tags WordPress actually emitted in
    these 35 posts and ignores the rest, keeping their TEXT. Dropping a wrapper
    but keeping its words is the right failure — it degrades a layout, never
    loses a sentence.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []          # finished blocks
        self.buf = []          # current block's inline text
        self.images = []       # urls, in document order
        self.list_stack = []   # 'ul' | 'ol'
        self.in_heading = 0
        self.in_quote = False
        self.href = None
        self.link_text = []

    # -- helpers
    def flush(self):
        text = "".join(self.buf).strip()
        self.buf = []
        if text:
            self.out.append(text)

    def emit(self, block):
        self.flush()
        self.out.append(block)

    def add(self, s):
        (self.link_text if self.href is not None else self.buf).append(s)

    # -- tags
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("p", "div", "section", "figure"):
            self.flush()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.flush()
            # h1 is the post title; a body heading starts one level down, which
            # is also what the site's renderer produces for '#'.
            self.in_heading = max(2, int(tag[1]))
            self.buf.append("#" * (self.in_heading - 1) + " ")
        elif tag == "img":
            src = a.get("src", "").strip()
            if src:
                self.images.append(src)
                alt = (a.get("alt") or "").strip().replace("]", "")
                self.emit(f"![{alt}](IMG::{src})")
        elif tag in ("strong", "b"):
            self.add("**")
        elif tag in ("em", "i"):
            self.add("*")
        elif tag == "a":
            self.href = a.get("href", "").strip()
            self.link_text = []
        elif tag == "br":
            self.add("\n")
        elif tag == "hr":
            self.emit("---")
        elif tag in ("ul", "ol"):
            self.flush()
            self.list_stack.append(tag)
        elif tag == "li":
            self.flush()
            marker = "- " if (self.list_stack and self.list_stack[-1] == "ul") else "1. "
            self.buf.append(marker)
        elif tag == "blockquote":
            self.flush()
            self.in_quote = True

    def handle_endtag(self, tag):
        if tag in ("p", "div", "section", "figure", "li"):
            self.flush()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.flush()
            self.in_heading = 0
        elif tag in ("strong", "b"):
            self.add("**")
        elif tag in ("em", "i"):
            self.add("*")
        elif tag == "a":
            text = "".join(self.link_text).strip()
            href, self.href, self.link_text = self.href, None, []
            if text and href and not href.startswith("#"):
                self.buf.append(f"[{text}]({href})")
            elif text:
                self.buf.append(text)
        elif tag in ("ul", "ol"):
            self.flush()
            if self.list_stack:
                self.list_stack.pop()
        elif tag == "blockquote":
            block = "".join(self.buf).strip()
            self.buf = []
            if block:
                self.out.append("> " + block.replace("\n", " "))
            self.in_quote = False

    def handle_data(self, data):
        if data.strip() or self.buf:
            self.add(re.sub(r"[ \t]+", " ", data))

    def result(self):
        self.flush()
        blocks, merged = [], []
        for b in self.out:
            # Consecutive list items belong to one list block, or the renderer
            # sees each as its own single-item list.
            if b.startswith(("- ", "1. ")) and merged and merged[-1].startswith(("- ", "1. ")):
                merged[-1] += "\n" + b
            else:
                merged.append(b)
        for b in merged:
            b = re.sub(r"\*\*\s*\*\*", "", b)      # empty emphasis left by stripped spans
            b = re.sub(r"\n{3,}", "\n\n", b).strip()
            if b:
                blocks.append(b)
        return "\n\n".join(blocks)


def to_markdown(raw_html):
    # Gutenberg's block delimiters are HTML comments and carry no content.
    cleaned = re.sub(r"<!--\s*/?wp:.*?-->", "", raw_html, flags=re.S)
    p = ToMarkdown()
    p.feed(cleaned)
    p.close()
    return p.result(), p.images


# ----------------------------------------------------------------- images

class Uploads:
    """The WordPress uploads folder, read straight out of the backup zip."""

    def __init__(self, zip_path):
        self.zip = zipfile.ZipFile(zip_path)
        # basename -> full entry, so a URL can be matched without caring which
        # year folder WordPress filed it under.
        self.by_name = {}
        for n in self.zip.namelist():
            if n.endswith("/"):
                continue
            self.by_name.setdefault(os.path.basename(n).lower(), n)

    def find(self, url):
        """
        The best local file for an image URL.

        WordPress rewrites `<img src>` to a RESIZED variant (`-768x1024`), so the
        original is tried first: it is the only copy with full resolution, and a
        1200x675 card cropped from a 768px-wide thumbnail would be visibly soft.
        """
        name = os.path.basename(url.split("?")[0]).lower()
        stripped = re.sub(r"-\d+x\d+(?=\.[a-z]+$)", "", name)
        for candidate in (stripped, name):
            hit = self.by_name.get(candidate)
            if hit:
                return hit
        return None

    def open_image(self, entry):
        with self.zip.open(entry) as fh:
            return Image.open(io.BytesIO(fh.read())).convert("RGB")


def save_body(im, path):
    out = im.copy()
    out.thumbnail((BODY_MAX, BODY_MAX), Image.LANCZOS)
    out.save(path, "WEBP", quality=QUALITY, method=6)


def save_thumb(im, path):
    """16:9, filled and centre-cropped — the same rule the admin panel applies."""
    src_w, src_h = im.size
    scale = max(THUMB_W / src_w, THUMB_H / src_h)
    resized = im.resize((max(1, round(src_w * scale)), max(1, round(src_h * scale))), Image.LANCZOS)
    left = (resized.width - THUMB_W) // 2
    top = (resized.height - THUMB_H) // 2
    resized.crop((left, top, left + THUMB_W, top + THUMB_H)).save(
        path, "WEBP", quality=QUALITY, method=6)


# ----------------------------------------------------------------- the export

def cdata(item, tag):
    m = re.search(rf"<{tag}[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</{tag}>", item, re.S)
    return html.unescape(m.group(1)).strip() if m else ""


def main():
    if not XML.exists():
        sys.exit(f"Export not found: {XML}")
    raw = XML.read_text(encoding="utf-8", errors="replace")
    items = re.findall(r"<item>.*?</item>", raw, re.S)

    # attachment post-id -> its file URL, for resolving the featured image
    attachments = {}
    for it in items:
        if "<wp:post_type><![CDATA[attachment]]>" in it:
            pid = cdata(it, "wp:post_id")
            url = cdata(it, "wp:attachment_url")
            if pid and url:
                attachments[pid] = url

    posts_xml = [it for it in items
                 if "<wp:post_type><![CDATA[post]]>" in it
                 and "<wp:status><![CDATA[publish]]>" in it]

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    uploads = Uploads(UPLOADS_ZIP)

    converted, redirects, warnings = [], [], []
    seen_slugs, image_cache = set(), {}
    stats = Counter()

    for it in posts_xml:
        title = cdata(it, "title")
        slug = cdata(it, "wp:post_name") or re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
        while slug in seen_slugs:
            slug += "-2"
        seen_slugs.add(slug)

        body_html = ""
        m = re.search(r"<content:encoded><!\[CDATA\[(.*?)\]\]></content:encoded>", it, re.S)
        if m:
            body_html = m.group(1)

        for marker, label in LOST_MARKERS:
            if marker in body_html:
                warnings.append(f"{slug}: contains {label} — check the result by eye")
                stats[label] += 1

        md, image_urls = to_markdown(body_html)

        # Featured image first, then anything used in the body.
        thumb_url = ""
        fm = re.search(r"<wp:meta_key><!\[CDATA\[_thumbnail_id\]\]></wp:meta_key>\s*"
                       r"<wp:meta_value><!\[CDATA\[(\d+)\]\]></wp:meta_value>", it, re.S)
        if fm:
            thumb_url = attachments.get(fm.group(1), "")
        if thumb_url and any(p in thumb_url.lower() for p in PLACEHOLDER_FEATURED):
            thumb_url = ""                      # the theme's house image, not this post's
            stats["placeholder featured image dropped"] += 1
        if not thumb_url and image_urls:
            thumb_url = image_urls[0]

        # --- images
        local = {}
        for url in dict.fromkeys(image_urls + ([thumb_url] if thumb_url else [])):
            if url in image_cache:
                local[url] = image_cache[url]
                continue
            entry = uploads.find(url)
            if not entry:
                warnings.append(f"{slug}: image not in the backup — {os.path.basename(url)}")
                stats["missing image"] += 1
                image_cache[url] = None
                continue
            try:
                im = uploads.open_image(entry)
            except Exception as exc:
                warnings.append(f"{slug}: could not read {os.path.basename(entry)} ({exc})")
                stats["unreadable image"] += 1
                image_cache[url] = None
                continue
            stem = re.sub(r"[^a-z0-9]+", "-",
                          os.path.splitext(os.path.basename(entry))[0].lower()).strip("-")[:60]
            rel = f"img/posts/{stem}.webp"
            save_body(im, REPO / rel)
            if url == thumb_url:
                save_thumb(im, REPO / f"img/posts/{stem}-thumb.webp")
            image_cache[url] = rel
            local[url] = rel
            stats["images"] += 1

        for url, rel in local.items():
            md = md.replace(f"IMG::{url}", rel if rel else "")
        # An image we could not find leaves an empty target; drop the whole line
        # rather than publishing a broken picture.
        md = re.sub(r"^!\[[^\]]*\]\(\)\s*$", "", md, flags=re.M)

        # --- linked files (PDFs, mostly) ------------------------------------
        # WordPress's file block emits the document twice: a titled link and a
        # bare "Download" beside it. Both point at the OLD server, so both would
        # break at cutover. Copy the file across and keep one link.
        md = re.sub(r"(\[[^\]]*\]\([^)]*\))\[Download\]\([^)]*\)", r"\1", md)

        for href in set(re.findall(r"\]\((https?://[^)]*wp-content/uploads/[^)]+)\)", md)):
            entry = uploads.find(href)
            name = os.path.basename(href.split("?")[0])
            if entry and name.lower().endswith(FILE_EXT):
                FILE_DIR.mkdir(parents=True, exist_ok=True)
                target = FILE_DIR / name
                if not target.exists():
                    target.write_bytes(uploads.zip.read(entry))
                    stats["files"] += 1
                md = md.replace(href, f"files/{name}")
            elif entry:
                # An image linked rather than embedded — point at the copy we
                # already made if there is one, else drop the link's target.
                rel = image_cache.get(href) or local.get(href)
                md = md.replace(href, rel or "#")
            else:
                warnings.append(f"{slug}: linked file not in the backup — {name}")
                stats["missing linked file"] += 1
                md = md.replace(href, "#")

        md = re.sub(r"\n{3,}", "\n\n", md).strip()

        thumb_rel = ""
        if thumb_url and image_cache.get(thumb_url):
            stem = os.path.splitext(os.path.basename(image_cache[thumb_url]))[0]
            candidate = f"img/posts/{stem}-thumb.webp"
            if (REPO / candidate).exists():
                thumb_rel = candidate

        cats = [c.lower() for c in re.findall(r'<category domain="category"[^>]*>'
                                              r'<!\[CDATA\[(.*?)\]\]></category>', it)]
        category = next((CATEGORY_MAP[c] for c in cats if c in CATEGORY_MAP), "News")

        date = (cdata(it, "wp:post_date") or "")[:10]
        link = cdata(it, "link")
        if link:
            path = re.sub(r"^https?://[^/]+", "", link)
            if path and path != "/":
                redirects.append(f"Redirect 301 {path} https://baptisthss.in/news/{slug}/")

        converted.append({
            "slug": slug,
            "title": title,
            "summary": "",
            "body_md": md,
            "category": category,
            "published_at": date,
            "author": "",
            "thumb": thumb_rel,
            "thumb_fit": "cover",
            "images": [v for v in local.values() if v],
        })
        stats["posts"] += 1

    converted.sort(key=lambda p: p["published_at"], reverse=True)

    OUT_JSON.write_text(json.dumps(
        {"generated_at": "", "count": len(converted), "posts": converted},
        ensure_ascii=False, indent=2), encoding="utf-8")

    OUT_REDIRECTS.write_text(
        "# Generated by migration/migrate.py — paste into site/.htaccess\n" +
        "\n".join(redirects) + "\n", encoding="utf-8")

    # For pasting into the Website_Posts sheet, so the SHEET stays the source of
    # truth rather than posts.json quietly becoming it.
    cols = ["post_id", "slug", "title", "summary", "body_md", "category",
            "published_at", "author", "thumb", "thumb_fit", "images", "status"]
    rows = ["\t".join(cols)]
    for i, p in enumerate(converted, 1):
        rows.append("\t".join([
            f"wp-{i:03d}-{p['slug'][:30]}", p["slug"], p["title"], "",
            p["body_md"].replace("\t", " ").replace("\n", "\\n"),
            p["category"], p["published_at"], "", p["thumb"], "cover",
            "\\n".join(p["images"]), "published",
        ]))
    OUT_TSV.write_text("\n".join(rows), encoding="utf-8")

    print(f"posts:      {stats['posts']}")
    print(f"images:     {stats['images']}")
    print(f"redirects:  {len(redirects)}")
    if warnings:
        print(f"\n{len(warnings)} thing(s) to check by eye:")
        for w in warnings[:40]:
            print("  -", w)
        if len(warnings) > 40:
            print(f"  ... and {len(warnings) - 40} more")
    print("\nwrote content/posts.json, migration/redirects.txt, migration/posts.tsv")


if __name__ == "__main__":
    main()
