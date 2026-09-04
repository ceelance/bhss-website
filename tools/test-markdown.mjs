/**
 * Tests for the markdown renderer.
 *
 * The formatting cases are here to stop regressions, but the ones that MATTER are
 * the safety cases: this renderer's whole claim is that it cannot emit a tag it
 * did not choose, on input written through a web form and published to the open
 * internet. Every assertion below marked SAFETY is that claim.
 *
 * Run: node tools/test-markdown.mjs
 */
import { renderMarkdown, escapeHtml, excerpt } from './markdown.mjs';

let failures = 0;
const ok = (cond, what) => {
  if (cond) return console.log('  ok   ' + what);
  failures++;
  console.log('  FAIL ' + what);
};
const has = (what, md, needle) => ok(renderMarkdown(md).includes(needle), what);
const lacks = (what, md, needle) => ok(!renderMarkdown(md).includes(needle), what);

console.log('\n=== SAFETY: no tag we did not choose can ever be emitted ===');
lacks('a script tag is text, not a script', 'Hello <script>alert(1)</script>', '<script');
has('...and is visible as what it was', 'Hello <script>alert(1)</script>', '&lt;script&gt;');
// The dangerous thing is a real <img TAG. The handler text still appears — as
// visible characters inside a text node, which is inert and is the whole point.
lacks('an img with an onerror handler never becomes a tag', '<img src=x onerror=alert(1)>', '<img src=x');
has('...it is shown as the text it was', '<img src=x onerror=alert(1)>', '&lt;img src=x');
lacks('an iframe is text', '<iframe src="evil"></iframe>', '<iframe');
lacks('a style block is text', '<style>body{display:none}</style>', '<style');
lacks('an attribute cannot be broken out of', '![x"onload="alert(1)](/a.png)', 'onload="alert');

console.log('\n=== SAFETY: link and image URLs ===');
has('javascript: becomes an inert #', '[click](javascript:alert(1))', 'href="#"');
lacks('...and the payload is gone', '[click](javascript:alert(1))', 'javascript:');
// Two different defences, and it matters which one fires. A TAB breaks the link
// pattern itself, so no anchor is produced at all; a control character that keeps
// the pattern intact is stripped by safeUrl and lands on '#'. Test both, or a
// passing suite could be resting on the wrong one.
lacks('a tab-broken link never becomes an anchor', '[x](java\tscript:alert(1))', '<a ');
has('a control character inside an otherwise-valid URL is neutralised',
    '[x](javascript:alert(1))', 'href="#"');
has('data: URLs are refused too', '[x](data:text/html;base64,PHN2Zz4=)', 'href="#"');
has('https is allowed', '[x](https://example.com/a)', 'href="https://example.com/a"');
has('mailto is allowed', '[mail](mailto:a@b.in)', 'href="mailto:a@b.in"');
has('a site-relative path is allowed', '[about](/about/)', 'href="/about/"');
has('a relative image path is allowed — this is how posts store them',
    '![x](img/posts/a.webp)', 'src="img/posts/a.webp"');
has('an external link gets noopener', '[x](https://example.com)', 'rel="noopener noreferrer"');
lacks('an internal one does not', '[x](https://baptisthss.in/a)', 'target="_blank"');

console.log('\n=== SAFETY: the code-span sentinel cannot be forged ===');
// The lifted-out code spans are restored by matching "<c0>". A post containing
// that literally must not be able to inject or steal a slot.
const forged = renderMarkdown('Literal <c0> in text, and `real code` after.');
ok(forged.includes('&lt;c0&gt;'), 'a literal <c0> in the text is escaped, not treated as a slot');
ok(forged.includes('<code>real code</code>'), '...and the genuine code span still renders');

console.log('\n=== formatting ===');
has('bold', 'a **bold** word', '<strong>bold</strong>');
has('italic', 'a *slanted* word', '<em>slanted</em>');
ok(renderMarkdown('**both**').includes('<strong>both</strong>') &&
   !renderMarkdown('**both**').includes('<em>'), 'bold is not eaten as two italics');
has('code span', 'run `npm test` now', '<code>npm test</code>');
has('a ** inside backticks stays literal', 'see `a ** b`', '<code>a ** b</code>');
has('a single # is h2 — h1 belongs to the page title', '# Results', '<h2>Results</h2>');
has('## is one level deeper', '## Results', '<h3>Results</h3>');
has('deeper heading', '#### Notes', '<h5>Notes</h5>');
has('bullet list', '- one\n- two', '<li>one</li>');
has('numbered list', '1. one\n2. two', '<ol>');
has('blockquote', '> quoted', '<blockquote>');
has('horizontal rule', '---', '<hr>');
has('a lone image becomes a figure', '![Sports day](img/a.webp)', '<figure>');
has('...with its alt text as the caption', '![Sports day](img/a.webp)', '<figcaption>Sports day</figcaption>');
lacks('an image with no alt gets no empty caption', '![](img/a.webp)', '<figcaption>');
has('a single newline inside a paragraph survives as a break',
    'Monday 9am\nTuesday 10am', '<br>');
ok(renderMarkdown('One.\n\nTwo.').match(/<p>/g).length === 2, 'a blank line starts a new paragraph');
has('an image inside a sentence stays inline', 'see ![x](/a.png) here', '<p>see <img');

console.log('\n=== excerpt ===');
ok(excerpt('# Title\n\nSome **bold** words here.') === 'Title Some bold words here.',
   'markdown is stripped, not rendered');
ok(excerpt('[link text](https://x.com) stays') === 'link text stays', 'link text is kept, the target dropped');
ok(!excerpt('![alt](img/a.webp) then text').includes('alt'), 'images contribute nothing');
ok(excerpt('word '.repeat(100), 40).endsWith('…'), 'long text is cut with an ellipsis');
ok(excerpt('word '.repeat(100), 40).length <= 42, '...and respects the cap');
ok(excerpt('') === '', 'empty in, empty out');

console.log('\n=== degenerate input never throws ===');
[null, undefined, '', '   ', '\n\n\n', '*', '**', '![](', '[x](', '#', '>'].forEach((v) => {
  try { renderMarkdown(v); ok(true, JSON.stringify(v) + ' renders without throwing'); }
  catch (e) { ok(false, JSON.stringify(v) + ' threw: ' + e.message); }
});
ok(escapeHtml(null) === '', 'escapeHtml(null) is empty, not "null"');

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nall green\n');
process.exit(failures ? 1 : 0);
