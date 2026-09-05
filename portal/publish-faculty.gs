/**
 * For the PORTAL's Apps Script project — not for this repo's build. It lives here
 * because what it writes is this repo's content, and because the shape it must
 * produce is defined by the build next door.
 *
 * WHAT IT DOES. Reads the staff out of `Users`, joins each teacher to the
 * subjects they are assigned in HS_Teachers / HSS_Teachers, and commits
 * `content/faculty.json` to the website repo — the same route and the same
 * helper `websitePublish_` already uses for posts. The commit is what triggers
 * the site build; nothing else needs poking.
 *
 * WHY A JOIN RATHER THAN A SUBJECT COLUMN. The assignment already exists:
 * HS_Teachers column A holds a teacher's name and column B the subject they
 * teach. A teacher on three rows teaches three subjects. Adding a subject column
 * to Users would duplicate that and let the two disagree.
 *
 * B, NOT C. Column C is the subject SLOT — "English1", "English2" — that Assign
 * Subjects uses to tell two English teachers apart. Column B is the clean name a
 * person reads.
 *
 * THE NAME IN COLUMN A IS `Users.name`, NOT `full_name`. That is the identifier
 * the assignment screens write and validate against, which is exactly why
 * full_name had to be a new column rather than an edit to the old one — rename a
 * person in Users and their subject assignments stop matching.
 *
 * WHAT IS PUBLISHED. Name, title, section, subject, photograph — what a school
 * prints in a prospectus. Emails and phone numbers are in `Users` too and are
 * deliberately not carried: the portal keeps a sign-in in front of those, and
 * this page is read by anyone at all.
 *
 * HOW TO RUN
 *   1. Add this file to the portal's Apps Script project.
 *   2. Run `publishFaculty` with DRY_RUN below left as `true`.
 *   3. Read the log — it prints the JSON it would commit, and names anyone it
 *      skipped and why.
 *   4. Set DRY_RUN to `false` and run it again. The site rebuilds in a minute.
 */

var PUBLISH_FACULTY_DRY_RUN = true;

/**
 * Publishing NOBODY empties the faculty page, and is almost never what anyone
 * meant — it is what a renamed column or an unticked switch looks like. So a run
 * that would publish nothing while named staff sit in the sheet stops instead.
 *
 * Set this true only to genuinely clear the page.
 */
var PUBLISH_FACULTY_ALLOW_EMPTY = false;

var FACULTY_CONTENT_PATH = 'content/faculty.json';

/**
 * A default section per role, used ONLY when `public_group` is empty.
 *
 * The office's own answer always wins: an app role says what a person may do in
 * the software, not what they do at the school — a super_admin may well teach
 * Physics. These exist so a row switched on before anyone filled the column in
 * still lands somewhere sensible instead of in a group called "Staff".
 */
var FACULTY_GROUP_BY_ROLE = {
  principal: 'Principal',
  vice_principal: 'Vice Principal',
  hs_teacher: 'High School',
  hss_teacher: 'Higher Secondary',
  non_teaching_staff: 'Office and support',
  admin: 'Office and support',
  admin_hs: 'Office and support',
  admin_hss: 'Office and support',
  super_admin: 'Office and support'
};

/** Likewise for the printed title, when `public_title` is empty. */
var FACULTY_TITLE_BY_ROLE = {
  principal: 'Principal',
  vice_principal: 'Vice Principal',
  hs_teacher: 'Teacher',
  hss_teacher: 'Teacher',
  non_teaching_staff: 'Staff',
  admin: 'Staff',
  admin_hs: 'Staff',
  admin_hss: 'Staff',
  super_admin: 'Staff'
};

/** A sheet checkbox gives a boolean; a typed cell gives text. Accept both. */
function facultyIsOn_(v) {
  if (v === true) return true;
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

// Counted while joining and reported once, rather than a line per row: a slot
// with no clean name beside it is a gap in the sheet, and a teacher quietly
// losing a subject should be visible without burying the rest of the log.
var facultySubjectsMissingName = 0;

/**
 * name (lowercased) -> [subject, ...], from both teacher sheets.
 *
 * COLUMN B, NOT COLUMN C. Column C is the per-teacher subject SLOT — "English1",
 * "English2" — which Assign Subjects uses to tell two English teachers apart.
 * Column B is the clean name, "English", and that is what a person reads. Print
 * column C on a public page and the school's website says a teacher teaches
 * "English1".
 *
 * It also makes the join tidier: a teacher holding English1 AND English2 is
 * teaching English once, and dedupes to one entry rather than two near-identical
 * ones.
 *
 * Both offsets are the constants Code.gs already declares — HST_SUBJECT_NAME_COL
 * for B and HST_NAME_COL for A — read rather than re-typed so the two cannot
 * drift apart.
 */
function facultySubjectsByTeacher_() {
  var out = {};
  facultySubjectsMissingName = 0;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ['HS_Teachers', 'HSS_Teachers'].forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    for (var r = HST_FIRST_DATA_ROW - 1; r < data.length; r++) {
      var who = String(data[r][HST_NAME_COL] == null ? '' : data[r][HST_NAME_COL]).trim();
      if (!who) continue;
      var subject = String(
        data[r][HST_SUBJECT_NAME_COL] == null ? '' : data[r][HST_SUBJECT_NAME_COL]).trim();
      if (!subject) {
        // A row assigned to a teacher whose clean name in B was never filled in.
        // Skipped rather than guessed at from the slot: "English1" is not a
        // subject anybody teaches.
        if (String(data[r][HST_SUBJECT_COL] == null ? '' : data[r][HST_SUBJECT_COL]).trim()) {
          facultySubjectsMissingName++;
        }
        continue;
      }
      var key = who.toLowerCase();
      if (!out[key]) out[key] = [];
      // A teacher can hold the same subject in both sections, or in two slots of
      // one section; print it once.
      if (out[key].indexOf(subject) === -1) out[key].push(subject);
    }
  });
  return out;
}

/**
 * Build the payload. Reads, never writes — so it is safe to call for a preview.
 *
 * Split out of publishFaculty so the SAME list can be produced three ways: by an
 * admin pressing a button, automatically after something changes, and by hand in
 * the editor. Three code paths building the list separately would drift, and the
 * one nobody looks at would be the one that got it wrong.
 */
function facultyBuild_() {
  var users = getSheetObjects('Users');
  var subjects = facultySubjectsByTeacher_();

  var staff = [];
  var skipped = [];
  var noGroup = [];

  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    var name = String(u.name == null ? '' : u.name).trim();
    var full = String(u.full_name == null ? '' : u.full_name).trim();

    if (!facultyIsOn_(u.on_website)) {
      if (name || full) skipped.push((full || name) + ' — on_website is not set');
      continue;
    }
    if (!name && !full) { skipped.push('(a row with no name at all)'); continue; }

    var role = String(u.role == null ? '' : u.role).trim().toLowerCase();
    var group = String(u.public_group == null ? '' : u.public_group).trim()
             || FACULTY_GROUP_BY_ROLE[role] || 'Office and support';
    if (!String(u.public_group == null ? '' : u.public_group).trim()) {
      noGroup.push((full || name) + ' -> ' + group + ' (from role "' + role + '")');
    }

    var person = {
      name: name,
      group: group,
      title: String(u.public_title == null ? '' : u.public_title).trim()
          || FACULTY_TITLE_BY_ROLE[role] || 'Staff'
    };
    // Sent only when present. The site prints full_name when it is there and
    // `name` when it is not, so a teacher appears under the staffroom name
    // until the office types the formal one — never as a blank.
    if (full) person.full_name = full;

    var mine = subjects[name.toLowerCase()];
    if (mine && mine.length) person.subject = mine.join(', ');

    var photo = String(u.photo == null ? '' : u.photo).trim();
    if (photo) person.photo = photo;

    staff.push(person);
  }

  var payload = {
    generated_at: new Date().toISOString(),
    count: staff.length,
    staff: staff
  };
  return {
    json: JSON.stringify(payload, null, 2),
    staff: staff, skipped: skipped, noGroup: noGroup, rows: users.length
  };
}

/**
 * Build and commit, returning a result instead of logging one.
 *
 * THE PROGRAMMATIC PATH — no dry run. The dry run exists for the editor, where a
 * person is about to publish a list nobody has seen; a button pressed by an admin
 * who has just edited one row, or a republish after a teacher accepts a
 * photograph, is not that situation. The empty-page guard below still applies,
 * because THAT one protects against a renamed column rather than against
 * inexperience.
 *
 * Never throws: callers are doing something else (saving a user, storing a
 * photograph) and a website that cannot be reached must not fail their action.
 */
function facultyPublishNow_(reason) {
  try {
    var built = facultyBuild_();

    if (!built.staff.length && built.skipped.length && !PUBLISH_FACULTY_ALLOW_EMPTY) {
      return { ok: false, count: 0, skipped: built.skipped.length,
               error: 'Refused: this would empty the faculty page while ' +
                      built.skipped.length + ' named row(s) sit in Users unpublished.' };
    }
    var cfg = websiteConfigError_();
    if (cfg) return { ok: false, count: built.staff.length, error: cfg };

    var res = websitePutFile_(
      FACULTY_CONTENT_PATH,
      Utilities.base64Encode(built.json, Utilities.Charset.UTF_8),
      'Publish ' + built.staff.length + ' staff' + (reason ? ' (' + reason + ')' : '')
    );
    return res.ok
      ? { ok: true, count: built.staff.length, skipped: built.skipped.length }
      : { ok: false, count: built.staff.length, error: res.error };
  } catch (err) {
    return { ok: false, count: 0,
             error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Republish quietly, for a caller whose real job is something else.
 *
 * Swallows everything. A teacher accepting a photograph, or an admin renaming
 * somebody, must not see a GitHub error — their action succeeded, and the site
 * catching up is a separate concern that the Refresh button can retry.
 */
function facultyRepublishQuietly_(reason) {
  try { facultyPublishNow_(reason); } catch (err) { /* deliberately silent */ }
}

/**
 * The editor entry point. Prints everything and honours the dry run.
 *
 * Kept for the case it was written for: publishing a list nobody has looked at,
 * where reading the log before committing is the whole point.
 */
function publishFaculty() {
  var built = facultyBuild_();
  var staff = built.staff, skipped = built.skipped, noGroup = built.noGroup;
  var json = built.json;
  var users = { length: built.rows };

  var log = [];
  log.push(PUBLISH_FACULTY_DRY_RUN
    ? '=== DRY RUN — nothing was committed ==='
    : '=== PUBLISHING ===');
  log.push('Staff to publish: ' + staff.length + ' of ' + users.length + ' rows in Users.');
  if (noGroup.length) {
    log.push('\nNo public_group set, so the role decided (set the column to override):');
    noGroup.forEach(function (s) { log.push('   ' + s); });
  }
  if (skipped.length) {
    log.push('\nNot published (' + skipped.length + '):');
    skipped.forEach(function (s) { log.push('   ' + s); });
  }
  if (facultySubjectsMissingName) {
    log.push('\n' + facultySubjectsMissingName + ' assignment row(s) have a subject slot ' +
             'in column C but no clean name in column B, so that subject is not shown. ' +
             'Fill column B in HS_Teachers / HSS_Teachers to include it.');
  }
  log.push('\n' + json);

  // The guard. Nobody to publish, but named people sitting in the sheet, means
  // something is off — a switch nobody ticked, a column renamed — far more often
  // than it means the school has no staff. Committing anyway would empty the page
  // and the log would look like a success.
  if (!staff.length && skipped.length && !PUBLISH_FACULTY_ALLOW_EMPTY) {
    log.push('\nSTOPPED: this would publish an empty faculty page while ' +
             skipped.length + ' named row(s) sit in Users unpublished.');
    log.push('If the switch is simply not set yet, run facultyTurnOnStaff (below).');
    log.push('If you really do mean to clear the page, set ' +
             'PUBLISH_FACULTY_ALLOW_EMPTY = true and run again.');
    Logger.log(log.join('\n'));
    return log.join('\n');
  }

  if (PUBLISH_FACULTY_DRY_RUN) {
    log.push('\nSet PUBLISH_FACULTY_DRY_RUN = false and run again to commit.');
    Logger.log(log.join('\n'));
    return log.join('\n');
  }

  var err = websiteConfigError_();
  if (err) { Logger.log(err); return err; }

  var res = websitePutFile_(
    FACULTY_CONTENT_PATH,
    Utilities.base64Encode(json, Utilities.Charset.UTF_8),
    'Publish ' + staff.length + ' staff'
  );
  log.push(res.ok
    ? '\nCommitted ' + FACULTY_CONTENT_PATH + '. The site rebuilds in a minute or two.'
    : '\nFAILED: ' + res.error);
  Logger.log(log.join('\n'));
  return log.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * ONE-OFF: switch `on_website` on for the staff who belong on the public page.
 *
 * Ticking seventy boxes by hand is an invitation to tick the wrong one, and the
 * blank rows below the data are easy to catch by accident — so this only ever
 * writes to a row that HAS A NAME AND A TEACHING OR SCHOOL ROLE.
 *
 * THE ADMIN ROLES ARE LEFT OFF DELIBERATELY. `admin`, `admin_hs`, `admin_hss`
 * and `super_admin` say what an account may do in the software, and in this sheet
 * some of them are shared logins rather than people — "HS Admin", "HSS Admin".
 * A real teacher who also administers the system should be ticked by hand, which
 * takes one click and cannot be got wrong by a script that never met them.
 *
 * Run with DRY_RUN true, read the list, then set it false.
 */
var FACULTY_TURN_ON_DRY_RUN = true;

var FACULTY_PUBLIC_ROLES = ['principal', 'vice_principal', 'hs_teacher',
                            'hss_teacher', 'non_teaching_staff'];

function facultyTurnOnStaff() {
  var sheet = getSheet('Users');
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return Logger.log('Users has no rows.');

  var headers = data[0].map(function (h) { return String(h).trim(); });
  var nameCol = headers.indexOf('name');
  var fullCol = headers.indexOf('full_name');
  var roleCol = headers.indexOf('role');
  var onCol = headers.indexOf('on_website');
  if (nameCol === -1 || roleCol === -1 || onCol === -1) {
    return Logger.log('ABORTED: Users needs "name", "role" and "on_website" columns. ' +
                      'Found: ' + headers.join(', '));
  }

  var turnOn = [], already = [], leftAlone = [];
  for (var r = 1; r < data.length; r++) {
    var name = String(data[r][nameCol] == null ? '' : data[r][nameCol]).trim();
    var full = fullCol === -1 ? '' : String(data[r][fullCol] == null ? '' : data[r][fullCol]).trim();
    if (!name && !full) continue;                        // a blank row, not a person
    var role = String(data[r][roleCol] == null ? '' : data[r][roleCol]).trim().toLowerCase();
    var shown = full || name;

    if (facultyIsOn_(data[r][onCol])) { already.push(shown); continue; }
    if (FACULTY_PUBLIC_ROLES.indexOf(role) === -1) {
      leftAlone.push(shown + '  (role "' + role + '")');
      continue;
    }
    if (!FACULTY_TURN_ON_DRY_RUN) sheet.getRange(r + 1, onCol + 1).setValue(true);
    turnOn.push(shown);
  }

  var out = [];
  out.push(FACULTY_TURN_ON_DRY_RUN ? '=== DRY RUN — nothing written ===' : '=== APPLIED ===');
  out.push((FACULTY_TURN_ON_DRY_RUN ? 'Would switch on ' : 'Switched on ') + turnOn.length + ':');
  turnOn.forEach(function (s) { out.push('   ' + s); });
  if (already.length) out.push('\nAlready on (' + already.length + '), untouched.');
  if (leftAlone.length) {
    out.push('\nLEFT OFF (' + leftAlone.length + ') — not a teaching or school role. ' +
             'Tick by hand anyone here who really does belong on the page:');
    leftAlone.forEach(function (s) { out.push('   ' + s); });
  }
  if (FACULTY_TURN_ON_DRY_RUN && turnOn.length) {
    out.push('\nSet FACULTY_TURN_ON_DRY_RUN = false and run again to apply.');
  }
  Logger.log(out.join('\n'));
  return out.join('\n');
}
