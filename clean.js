// ============================================================
// clean.js — Standalone doc cleaner
// Requires: nothing (pure Node.js, no npm packages)
//
// Usage:
//   node clean.js              <- clean all .md files in ./docs/
//   node clean.js --dry-run    <- preview changes without writing
//   node clean.js --dedupe     <- also delete near-duplicate files
// ============================================================

const fs   = require('fs');
const path = require('path');

const { walkDir }      = require('./lib/utils');
const { cleanDocument } = require('./lib/clean');

const DOCS_DIR = path.resolve(process.env.SE_DOCS_DIR || './docs');
const DRY_RUN  = process.argv.includes('--dry-run');
const DEDUPE   = process.argv.includes('--dedupe');

function dedupeFiles(files) {
  console.log('\nChecking for near-duplicates...');

  const fileData = files.map(fp => ({
    path: fp,
    rel:  path.relative(DOCS_DIR, fp),
    lines: fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim().length > 10),
    size:  fs.statSync(fp).size,
  }));

  const toDelete = new Set();

  for (let i = 0; i < fileData.length; i++) {
    if (toDelete.has(fileData[i].path)) continue;
    for (let j = i + 1; j < fileData.length; j++) {
      if (toDelete.has(fileData[j].path)) continue;
      const a = fileData[i];
      const b = fileData[j];
      if (a.lines.length < 5 || b.lines.length < 5) continue;

      const setA    = new Set(a.lines);
      const overlap = b.lines.filter(l => setA.has(l)).length;
      const pct     = Math.round((overlap / Math.max(a.lines.length, b.lines.length)) * 100);

      if (pct >= 90) {
        const deleteTarget = a.size >= b.size ? b.path : a.path;
        const keepTarget   = a.size >= b.size ? a.rel  : b.rel;
        const deleteRel    = path.relative(DOCS_DIR, deleteTarget);
        console.log(`  [DUPE] ${deleteRel}`);
        console.log(`         → keeping ${keepTarget} (${pct}% overlap)`);
        toDelete.add(deleteTarget);
      }
    }
  }

  if (toDelete.size === 0) {
    console.log('  No duplicates found.');
    return;
  }

  console.log(`\n  ${toDelete.size} duplicate file(s) found.`);
  if (DRY_RUN) {
    console.log('  (dry run — not deleting)');
    return;
  }

  for (const fp of toDelete) {
    fs.unlinkSync(fp);
  }
  console.log(`  ${toDelete.size} file(s) deleted.`);
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error('ERROR: docs/ folder not found at ' + DOCS_DIR);
    console.error('Make sure you run this from the same folder as crawl.js');
    process.exit(1);
  }

  const files = walkDir(DOCS_DIR);

  if (files.length === 0) {
    console.error('No .md files found in ' + DOCS_DIR);
    process.exit(1);
  }

  const mode = DRY_RUN ? 'DRY RUN — ' : '';
  console.log('\n' + mode + 'Cleaning ' + files.length + ' files...\n');

  let totalOriginal = 0;
  let totalCleaned  = 0;
  let errors        = 0;
  let unchanged     = 0;

  for (const filePath of files.sort()) {
    const rel = path.relative(DOCS_DIR, filePath);
    const raw = fs.readFileSync(filePath, 'utf-8');

    try {
      const cleaned       = cleanDocument(raw);
      const originalLines = raw.split('\n').length;
      const cleanedLines  = cleaned.split('\n').length;
      const reduction     = Math.round((1 - cleanedLines / originalLines) * 100);

      totalOriginal += originalLines;
      totalCleaned  += cleanedLines;

      if (reduction === 0) {
        unchanged++;
      } else {
        const tag = reduction > 30 ? '[+++]' : reduction > 10 ? '[+]  ' : '[~]  ';
        console.log('  ' + tag + ' ' + rel + ' (' + reduction + '% reduction)');
      }

      if (!DRY_RUN) {
        fs.writeFileSync(filePath, cleaned, 'utf-8');
      }
    } catch (err) {
      console.error('  [ERR] ' + rel + ' — ' + err.message);
      errors++;
    }
  }

  if (DEDUPE) {
    dedupeFiles(walkDir(DOCS_DIR));
  }

  const totalReduction = Math.round((1 - totalCleaned / totalOriginal) * 100);
  console.log('\n' + '-'.repeat(60));
  console.log('Files    : ' + files.length + ' (' + unchanged + ' already clean)');
  console.log('Lines    : ' + totalOriginal.toLocaleString() + ' -> ' + totalCleaned.toLocaleString() + ' (' + totalReduction + '% reduction)');
  if (errors > 0) console.log('Errors   : ' + errors + ' file(s) failed');

  if (DRY_RUN) {
    console.log('\nDry run done. Remove --dry-run to apply changes.');
  } else {
    console.log('\nDone. Run: node validate.js');
  }
}

main();
