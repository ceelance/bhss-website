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
 * HS_Teachers column A holds a teacher's name and column C the subject they
 * teach. A teacher on three rows teaches three subjects. Adding a subject column
 * to Users would duplicate that and let the two disagree.
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

/**
 * name (lowercased) -> [subject, ...], from both teacher sheets.
 *
 * Column offsets are the ones Code.gs already declares for the assignment
 * screens: name in A, subject in C, data from row 3. Read here rather than
 * re-derived so the two cannot drift apart.
 */
function facultySubjectsByTeacher_() {
  var out = {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ['HS_Teachers', 'HSS_Teachers'].forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    for (var r = HST_FIRST_DATA_ROW - 1; r < data.length; r++) {
      var who = String(data[r][HST_NAME_COL] == null ? '' : data[r][HST_NAME_COL]).trim();
      var subject = String(data[r][HST_SUBJECT_COL] == null ? '' : data[r][HST_SUBJECT_COL]).trim();
      if (!who || !subject) continue;
      var key = who.toLowerCase();
      if (!out[key]) out[key] = [];
      // A teacher can hold the same subject in both sections; print it once.
      if (out[key].indexOf(subject) === -1) out[key].push(subject);
    }
  });
  return out;
}

function publishFaculty() {
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
  var json = JSON.stringify(payload, null, 2);

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
  log.push('\n' + json);

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
