// ============================================================
// schedule-sync.js — Install macOS launchd schedules for sync.js
// Requires: nothing (pure Node.js built-ins only)
//
// Usage:
//   node schedule-sync.js           <- write and load both plists
//   node schedule-sync.js --remove  <- unload and delete both plists
//   node schedule-sync.js --status  <- show launchctl list for both jobs
//
// Schedules:
//   Weekly full sync          — Sundays at 2:00am
//   Daily release notes sync  — Every day at 6:00am
//   Weekly PDF sync           — Mondays at 3:00am
// ============================================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const crawlDir = path.resolve(__dirname);
const logDir   = path.join(crawlDir, 'logs');
const agentDir = path.join(os.homedir(), 'Library', 'LaunchAgents');

const WEEKLY_LABEL  = 'com.opswat-docs-sync';
const DAILY_LABEL   = 'com.opswat-docs-sync-releasenotes';
const PDFS_LABEL    = 'com.opswat-docs-sync-pdfs';
const WEEKLY_PLIST  = path.join(agentDir, WEEKLY_LABEL + '.plist');
const DAILY_PLIST   = path.join(agentDir, DAILY_LABEL  + '.plist');
const PDFS_PLIST    = path.join(agentDir, PDFS_LABEL   + '.plist');

function resolveNodePath() {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    console.error('ERROR: could not resolve `node` via `which node`. Is node on PATH?');
    process.exit(1);
  }
}

function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPlist({ label, args, scheduleXml, stdout, stderr, workingDir }) {
  const argsXml = args.map(a => '    <string>' + xmlEscape(a) + '</string>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDir)}</string>
${scheduleXml}
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

const WEEKLY_SCHEDULE = `  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>0</integer>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>0</integer>
  </dict>`;

const DAILY_SCHEDULE = `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>0</integer>
  </dict>`;

const PDFS_SCHEDULE = `  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>`;

function runLaunchctl(args, { allowFail = false } = {}) {
  try {
    execSync('launchctl ' + args, { stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    if (!allowFail) {
      console.error('  launchctl ' + args + ' failed: ' + (err.stderr ? err.stderr.toString().trim() : err.message));
    }
    return { ok: false, err };
  }
}

function install() {
  fs.mkdirSync(logDir,   { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const nodePath = resolveNodePath();
  const syncJs     = path.join(crawlDir, 'sync.js');
  const syncPdfsJs = path.join(crawlDir, 'sync-pdfs.js');

  if (!fs.existsSync(syncJs)) {
    console.error('ERROR: sync.js not found at ' + syncJs);
    process.exit(1);
  }
  if (!fs.existsSync(syncPdfsJs)) {
    console.error('ERROR: sync-pdfs.js not found at ' + syncPdfsJs);
    process.exit(1);
  }

  const weeklyPlist = buildPlist({
    label:       WEEKLY_LABEL,
    args:        [nodePath, syncJs],
    scheduleXml: WEEKLY_SCHEDULE,
    stdout:      path.join(logDir, 'sync.log'),
    stderr:      path.join(logDir, 'sync-error.log'),
    workingDir:  crawlDir,
  });

  const dailyPlist = buildPlist({
    label:       DAILY_LABEL,
    args:        [nodePath, syncJs, '--release-notes'],
    scheduleXml: DAILY_SCHEDULE,
    stdout:      path.join(logDir, 'sync-releasenotes.log'),
    stderr:      path.join(logDir, 'sync-releasenotes-error.log'),
    workingDir:  crawlDir,
  });

  const pdfsPlist = buildPlist({
    label:       PDFS_LABEL,
    args:        [nodePath, syncPdfsJs],
    scheduleXml: PDFS_SCHEDULE,
    stdout:      path.join(logDir, 'sync-pdfs.log'),
    stderr:      path.join(logDir, 'sync-pdfs-error.log'),
    workingDir:  crawlDir,
  });

  // Unload first in case they're already loaded (avoid "service already loaded")
  runLaunchctl('unload ' + JSON.stringify(WEEKLY_PLIST), { allowFail: true });
  runLaunchctl('unload ' + JSON.stringify(DAILY_PLIST),  { allowFail: true });
  runLaunchctl('unload ' + JSON.stringify(PDFS_PLIST),   { allowFail: true });

  fs.writeFileSync(WEEKLY_PLIST, weeklyPlist, 'utf-8');
  fs.writeFileSync(DAILY_PLIST,  dailyPlist,  'utf-8');
  fs.writeFileSync(PDFS_PLIST,   pdfsPlist,   'utf-8');

  const w = runLaunchctl('load ' + JSON.stringify(WEEKLY_PLIST));
  const d = runLaunchctl('load ' + JSON.stringify(DAILY_PLIST));
  const p = runLaunchctl('load ' + JSON.stringify(PDFS_PLIST));

  if (!w.ok || !d.ok || !p.ok) {
    console.error('\nOne or more plists failed to load. Check launchctl errors above.');
    process.exit(1);
  }

  console.log('\n  ✓ Weekly full sync     — Sundays at 2:00am');
  console.log('  ✓ Daily release notes  — Every day at 6:00am');
  console.log('  ✓ Weekly PDF sync      — Mondays at 3:00am');
  console.log('  Logs: ' + logDir + '/');
  console.log('');
  console.log('  To trigger manually: node sync.js  |  node sync-pdfs.js');
  console.log('  To remove schedules: node schedule-sync.js --remove');
  console.log('');
}

function remove() {
  runLaunchctl('unload ' + JSON.stringify(WEEKLY_PLIST), { allowFail: true });
  runLaunchctl('unload ' + JSON.stringify(DAILY_PLIST),  { allowFail: true });
  runLaunchctl('unload ' + JSON.stringify(PDFS_PLIST),   { allowFail: true });

  for (const p of [WEEKLY_PLIST, DAILY_PLIST, PDFS_PLIST]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('  removed: ' + p);
    } else {
      console.log('  not present: ' + p);
    }
  }
  console.log('');
}

function status() {
  for (const label of [WEEKLY_LABEL, DAILY_LABEL, PDFS_LABEL]) {
    console.log('\n  [' + label + ']');
    try {
      const out = execSync('launchctl list ' + JSON.stringify(label), { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(out.trim().split('\n').map(l => '    ' + l).join('\n'));
    } catch (err) {
      const msg = err.stderr ? err.stderr.toString().trim() : err.message;
      console.log('    not loaded (' + msg + ')');
    }
  }
  console.log('');
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('ERROR: schedule-sync.js targets macOS launchd. Detected platform: ' + process.platform);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.includes('--remove'))      remove();
  else if (args.includes('--status')) status();
  else if (args.length === 0)         install();
  else {
    console.error('ERROR: unknown flag(s): ' + args.join(' '));
    console.error('Usage:');
    console.error('  node schedule-sync.js           install and load both plists');
    console.error('  node schedule-sync.js --remove  unload and delete both plists');
    console.error('  node schedule-sync.js --status  show launchctl list for both jobs');
    process.exit(1);
  }
}

main();
