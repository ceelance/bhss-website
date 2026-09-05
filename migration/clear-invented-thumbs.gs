/**
 * ONE-OFF, for the PORTAL's Apps Script project — not for this repo's build.
 * It lives here because it finishes a job that started here: see the commit
 * "Stop inventing thumbnails, and fall back to a school photograph".
 *
 * WHAT IT FIXES. 19 of the 35 migrated posts had the old WordPress theme's
 * `posts-default` placeholder as their featured image — they showed a house
 * image, not a picture of their own. migration/migrate.py correctly dropped that
 * placeholder and then wrongly substituted the first image in the post body, so
 * 12 posts got a thumbnail WordPress never gave them. Most are portrait scans of
 * notices, which the 16:9 card crops the text out of.
 *
 * `content/posts.json` in the website repo is already corrected. But the SHEET is
 * the source of truth and still holds the old values, and every publish rebuilds
 * that file wholesale from the sheet — so without this, the next post the office
 * publishes silently restores all 12 wrong thumbnails.
 *
 * HOW TO RUN
 *   1. Open the portal's Apps Script project and add this file.
 *   2. Run `clearInventedThumbs` with DRY_RUN below left as `true`.
 *   3. Read the log. It names every row it would touch and why.
 *   4. Set DRY_RUN to `false` and run it again.
 *   5. That is all. Nothing needs republishing — the repo is already right, and
 *      this only stops the sheet from undoing it. The next ordinary publish will
 *      now agree with what is deployed.
 *
 * SAFE TO RUN TWICE. A cell is cleared only when it still holds the exact wrong
 * value recorded below, so a thumbnail somebody chooses deliberately later can
 * never be wiped by a stray re-run. Anything else is reported and left alone.
 */

var CLEAR_INVENTED_THUMBS_DRY_RUN = true;

/**
 * slug -> the exact invented value to clear.
 *
 * Paired rather than listed by slug alone, and that pairing is the safety: the
 * script matches the value before touching it, so it cannot destroy a later
 * editorial choice. Taken from commit 62f2911 of the website repo, the last
 * state of posts.json before the fix.
 */
var CLEAR_INVENTED_THUMBS = [
  ['pre-matric-hs-scholarship-notice',
   'img/posts/screenshot-2026-08-24-22-07-07-62-e2d5b3f32b79de1d45acd1fad9-thumb.webp'],
  ['post-matric-hss-scholarship-notice',
   'img/posts/screenshot-2026-08-24-22-07-32-61-e2d5b3f32b79de1d45acd1fad9-thumb.webp'],
  ['principal-in-state-award-a-dawng',
   'img/posts/sir-muantea-1-thumb.webp'],
  ['class-xi-commencement-rescheduled',
   'img/posts/img-20260506-wa00294419072072183027030-thumb.webp'],
  ['xi-admission-2026-27-selected-list',
   'img/posts/arts-a-01-thumb.webp'],
  ['bhss-hsslc-2025-26-result',
   'img/posts/img-20260502-wa00025055308927530541552-thumb.webp'],
  ['class-ix-selected-list-2026-27',
   'img/posts/01-thumb.webp'],
  ['class-ix-admission-notice-for-2026-27',
   'img/posts/screenshot-2026-02-10-15-04-00-65-c37d74246d9c81aa0bb824b57e-thumb.webp'],
  ['class-xi-admission-notice-for-academic-session-2025-2026',
   'img/posts/admission-1-rotated-thumb.webp'],
  ['admission-notice-for-class-ix',
   'img/posts/class-ix-admission-notice-thumb.webp'],
  ['gospel-meeting-hun-hman-mek-a-ni',
   'img/posts/img202408071406465437613012373626092-thumb.webp'],
  ['2nd-term-start-date-test-post',
   'img/posts/img-20240727-wa00192342003910097307019-thumb.webp']
];

function clearInventedThumbs() {
  var sheet = websitePostsSheet_(false);
  if (!sheet) return log_('No ' + WEBSITE_POSTS_SHEET + ' sheet. Nothing to do.');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return log_('The sheet has no post rows. Nothing to do.');

  // Columns are found by HEADER NAME, not by position: the sheet gains columns
  // over time (websitePostWrite_ appends one when it meets a new field), and a
  // hardcoded "column I" would quietly start clearing the wrong thing.
  var headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
  var slugCol = headers.indexOf('slug');
  var thumbCol = headers.indexOf('thumb');
  if (slugCol === -1 || thumbCol === -1) {
    return log_('ABORTED: the sheet has no "slug" and/or "thumb" column.');
  }

  var wanted = {};
  CLEAR_INVENTED_THUMBS.forEach(function (pair) { wanted[pair[0]] = pair[1]; });

  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues();
  var cleared = [], alreadyEmpty = [], changed = [], missing = {};
  Object.keys(wanted).forEach(function (s) { missing[s] = true; });

  for (var i = 0; i < rows.length; i++) {
    var slug = String(rows[i][slugCol] || '').trim();
    if (!wanted.hasOwnProperty(slug)) continue;
    delete missing[slug];

    var current = String(rows[i][thumbCol] || '').trim();
    var row = i + 2;

    if (current === '') {
      alreadyEmpty.push(slug);
    } else if (current === wanted[slug]) {
      if (!CLEAR_INVENTED_THUMBS_DRY_RUN) sheet.getRange(row, thumbCol + 1).setValue('');
      cleared.push('row ' + row + '  ' + slug);
    } else {
      // Somebody has since chosen a different picture. That is a decision, not
      // the migration's mistake, so it is reported and left exactly as it is.
      changed.push('row ' + row + '  ' + slug + '\n      now: ' + current +
                   '\n      expected: ' + wanted[slug]);
    }
  }

  var out = [];
  out.push(CLEAR_INVENTED_THUMBS_DRY_RUN
    ? '=== DRY RUN — nothing was written ==='
    : '=== APPLIED — the sheet has been changed ===');
  out.push((CLEAR_INVENTED_THUMBS_DRY_RUN ? 'Would clear ' : 'Cleared ') + cleared.length + ':');
  cleared.forEach(function (s) { out.push('   ' + s); });

  if (alreadyEmpty.length) {
    out.push('\nAlready empty, left alone (' + alreadyEmpty.length + '):');
    alreadyEmpty.forEach(function (s) { out.push('   ' + s); });
  }
  if (changed.length) {
    out.push('\nCHANGED SINCE — someone picked a different picture. LEFT ALONE (' +
             changed.length + '). Check these by eye:');
    changed.forEach(function (s) { out.push('   ' + s); });
  }
  var gone = Object.keys(missing);
  if (gone.length) {
    out.push('\nNot found in the sheet (' + gone.length + '):');
    gone.forEach(function (s) { out.push('   ' + s); });
  }
  if (CLEAR_INVENTED_THUMBS_DRY_RUN && cleared.length) {
    out.push('\nSet CLEAR_INVENTED_THUMBS_DRY_RUN = false and run again to apply.');
  }

  return log_(out.join('\n'));
}

function log_(msg) {
  Logger.log(msg);
  return msg;
}
