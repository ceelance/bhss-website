#!/usr/bin/env python3
"""
Turn a folder of staff photographs into the square WebP files the faculty page
wants, and print the sheet values that point at them.

    python tools/staff-photos.py --in "D:\\staff pics"          # dry run
    python tools/staff-photos.py --in "D:\\staff pics" --write   # actually write

DRY RUN BY DEFAULT, like every other script here that changes something the
public can see. The first run tells you which photo it matched to whom; look at
that list before letting it write, because a mismatch here puts one teacher's
face on another teacher's card.

NOT PART OF THE BUILD. It needs Pillow, which is fine precisely because it never
runs in CI — the dependency-free rule exists to protect the deploy key, and this
runs on your own machine. `node tools/build.mjs` still needs nothing installed.

WHAT IT DOES NOT DO: write to the sheet. It prints two columns for you to paste
into `Users.photo`, because a script that edits the staff sheet unattended is a
much bigger thing to trust than one that writes image files into a folder.
"""

import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageOps

# A Windows console is cp1252, and this prints staff names it did not choose.
# Without this, a name carrying anything outside that set kills the run with a
# UnicodeEncodeError halfway through a list you were reading.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parent.parent
FACULTY = REPO / "content" / "faculty.json"
OUT_DIR = REPO / "img" / "staff"

# 400px because that is what the card declares (width="400" height="400") and
# what it fills with object-fit: cover. Larger is wasted bytes on a mobile
# connection; smaller goes soft on a high-density screen.
SIDE = 400
QUALITY = 82

# The same list the build uses for initials, and it must STAY the same: a photo
# named "Ramliani.jpg" has to find "Miss Ramliani", and the card has to call her
# R. Keep this in step with HONORIFICS in tools/build.mjs.
HONORIFICS = {"sir", "madam", "mdm", "miss", "mr", "mrs", "ms", "dr",
              "rev", "upa", "pu", "pi"}

# How far down the excess to start the crop on a TALL photo. Not 0.5: a portrait
# from a phone has the head in the upper third, and a centred square takes the
# chest and cuts the forehead — which is exactly the complaint that got the
# migrated post thumbnails thrown out. Not 0 either, or a photo with headroom
# crops to hair and ceiling.
TALL_CROP_BIAS = 0.18


def norm(s):
    """A name reduced to what two spellings of it have in common."""
    s = re.sub(r"\([^)]*\)", " ", str(s or "")).lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    words = [w for w in s.split() if w]
    # Drop a leading honorific, but only if something is left to keep.
    if len(words) > 1 and words[0] in HONORIFICS:
        words = words[1:]
    return " ".join(words)


def slugify(name):
    s = norm(name)
    return re.sub(r"\s+", "-", s) or "staff"


def square(img):
    """Centre horizontally, bias upward vertically, then resize."""
    # A phone writes the orientation in EXIF rather than rotating the pixels.
    # Without this, portraits arrive on their side and every face is sideways.
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        flat = Image.new("RGB", img.size, (255, 255, 255))
        flat.paste(img, mask=img.split()[-1])
        img = flat
    else:
        img = img.convert("RGB")

    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = int((h - side) * TALL_CROP_BIAS) if h > w else (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    return img.resize((SIDE, SIDE), Image.LANCZOS)


def load_staff():
    if not FACULTY.exists():
        sys.exit(f"No {FACULTY}. Publish the faculty from the portal first.")
    data = json.loads(FACULTY.read_text(encoding="utf-8"))
    people = data.get("staff", [])
    if not people:
        sys.exit("faculty.json has no staff in it.")
    return people


def match(stem, people, index):
    """Filename -> one staff member, or None with a reason."""
    key = norm(stem)
    if not key:
        return None, "no usable name in the filename"
    hits = index.get(key)
    if hits and len(hits) == 1:
        return hits[0], "exact"
    if hits:
        return None, f"matches {len(hits)} people called '{key}'"
    # Fall back to "the only name that contains this", which catches
    # "Davida.jpg" for "Sir Davida HS" — but ONLY if it is unambiguous.
    loose = [p for k, ps in index.items() if key in k.split() or key in k
             for p in ps]
    uniq = {id(p): p for p in loose}
    if len(uniq) == 1:
        return next(iter(uniq.values())), "partial"
    if uniq:
        names = ", ".join(sorted(p["name"] for p in uniq.values()))
        return None, f"ambiguous — could be {names}"
    return None, "no staff member of that name"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True,
                    help="folder holding the photographs")
    ap.add_argument("--write", action="store_true",
                    help="actually write the files (default is a dry run)")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        sys.exit(f"Not a folder: {src}")

    people = load_staff()
    index = {}
    for p in people:
        for label in (p.get("name"), p.get("full_name")):
            if label:
                index.setdefault(norm(label), []).append(p)

    exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic"}
    files = sorted(f for f in src.iterdir()
                   if f.is_file() and f.suffix.lower() in exts)
    if not files:
        sys.exit(f"No pictures in {src}")

    print(f"{'DRY RUN — nothing written' if not args.write else 'WRITING'}"
          f"   {len(files)} picture(s), {len(people)} staff\n")

    rows, problems, taken = [], [], {}
    for f in files:
        person, why = match(f.stem, people, index)
        if not person:
            problems.append((f.name, why))
            continue
        slug = slugify(person["name"])
        if slug in taken:
            problems.append((f.name, f"'{taken[slug]}' already claimed {slug}.webp"))
            continue
        taken[slug] = f.name

        try:
            with Image.open(f) as im:
                w, h = im.size
                out = square(im)
        except Exception as err:                       # noqa: BLE001
            problems.append((f.name, f"could not be read ({err})"))
            continue

        rel = f"img/staff/{slug}.webp"
        note = "" if why == "exact" else f"   [{why} match — check this]"
        print(f"  {f.name:<38} -> {person['name']:<24} {w}x{h}{note}")
        rows.append((person["name"], rel))
        if args.write:
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            out.save(OUT_DIR / f"{slug}.webp", "WEBP", quality=QUALITY, method=6)

    if problems:
        print("\nNot matched — rename the file to the staff member's name and re-run:")
        for name, why in problems:
            print(f"  {name:<38} {why}")

    missing = [p["name"] for p in people
               if slugify(p["name"]) not in taken and not p.get("photo")]
    if missing:
        print(f"\nStill without a photograph ({len(missing)}): "
              + ", ".join(sorted(missing)))

    if rows:
        print("\n" + "=" * 68)
        print("Paste into the Users sheet — column A is `name`, put the second")
        print("column in `photo`. Then run publishFaculty.")
        print("=" * 68)
        for name, rel in rows:
            print(f"{name}\t{rel}")

    if not args.write and rows:
        print(f"\nNothing was written. Re-run with --write once the list above "
              f"looks right.")


if __name__ == "__main__":
    main()
