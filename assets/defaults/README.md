# Stand-in pictures

A post with no picture of its own gets one of these — on its news card, at the
top of the post, and as the WhatsApp/Facebook link preview.

**Drop images in here and they join the rotation.** No code to change and no list
to keep in step: the build reads whatever is in this folder
([tools/build.mjs](../../tools/build.mjs), `DEFAULT_IMAGES`). Remove one and it
drops out. With the folder empty, the site falls back to `assets/og-default.jpg`.

## What to put here

- **1200 × 675 pixels** (16:9). The card and the post hero are both 16:9, so an
  image cut to size is never cropped by the browser. A different shape will be
  centre-cropped to fit, which is fine for a photograph and bad for anything with
  writing in it.
- **JPEG**, quality ~82. A photograph as a PNG is several times the size for no
  visible gain.
- `.jpg`, `.jpeg`, `.png` and `.webp` are recognised. Anything else here is
  ignored — this README included.
- **Photographs of the school**, and nothing with text baked in: the same picture
  appears on many different posts, so anything specific will end up over a post it
  has nothing to do with.

Five to ten is a good number. Fewer than that and the repetition shows down the
news grid.

## Which post gets which

Not at random. The choice is made by hashing the post's slug, so **a post keeps
the same picture for good**. This matters: a genuinely random pick would be
re-rolled on every build, so a notice already shared to WhatsApp would show a
different photograph the next time anyone opened the link.

The consequence is that **adding or removing a file reshuffles the posts that
have no picture of their own** — the rotation is a different size, so the hash
lands elsewhere. Harmless, but don't be surprised by it, and do the shuffling
before a batch of posts gets shared rather than after.
