// ============================================================
// validate.js  — Standalone doc validator
// Requires: nothing (pure Node.js, no npm packages)
//
// Usage:
//   node validate.js               <- validate all .md files in ./docs/
//   node validate.js --show-junk   <- also print every junk line found
//   node validate.js --force       <- report only, don't exit with error code
// ============================================================

const fs   = require('fs');
const path = require('path');

const { walkDir }              = require('./lib/utils');
const { EXACT_JUNK, REGEX_JUNK } = require('./lib/clean');

const DOCS_DIR  = path.resolve(process.env.SE_DOCS_DIR || './docs');
const FORCE     = process.argv.includes('--force');
const SHOW_JUNK = process.argv.includes('--show-junk');

const SENSITIVE = [
  { name: 'JWT token',    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Bearer token', pattern: /Bearer\s+[A-Za-z0-9]{30,}/ },
  { name: 'API key',      pattern: /['"](sk|pk|api|key)-[A-Za-z0-9]{20,}['"]/i },
];

function isJunk(line) {
  const t = line.trim();
  if (!t) return false;
  if (EXACT_JUNK.has(t)) return true;
  if (REGEX_JUNK.some(p => p.test(t))) return true;
  return false;
}

function countShattered(lines) {
  let count = 0;
  for (let i = 0; i < lines.length - 2; i++) {
    if (
      lines[i].trim() === '```' &&
      lines[i+1].trim() !== '' && lines[i+1].trim() !== '```' &&
      lines[i+2].trim() === '```'
    ) count++;
  }
  return count;
}

function analyzeFile(filePath, rel) {
  const stat    = fs.statSync(filePath);
  const sizeKB  = Math.round(stat.size / 1024);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines   = content.split('\n');

  const h2h3Count       = lines.filter(l => /^#{2,3}\s+/.test(l)).length;
  const junkLines       = lines.filter(l => isJunk(l));
  const junkCount       = junkLines.length;
  const junkPct         = Math.round((junkCount / Math.max(lines.length, 1)) * 100);
  const shatteredCount  = countShattered(lines);
  const contentLines    = lines.filter(l => l.trim() && !isJunk(l)).length;
  const estimatedChunks = Math.max(h2h3Count, 1);

  const breadcrumbLines = lines.filter(l =>
    (l.match(/\[.*?\]\(https?:\/\/[^)]+\)/g) || []).length >= 3
  ).length;

  const modalCount = lines.filter(l => l.trim() === '×').length;

  const sensitiveHits = [];
  for (const { name, pattern } of SENSITIVE) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        sensitiveHits.push({ name, line: i + 1, preview: lines[i].trim().slice(0, 60) });
        break;
      }
    }
  }

  const errors   = [];
  const warnings = [];

  if (contentLines < 5) {
    errors.push({ code: 'TOO_THIN', msg: 'Only ' + contentLines + ' content lines — file is nearly empty' });
  }
  if (shatteredCount >= 3) {
    errors.push({ code: 'SHATTERED_CODE', msg: shatteredCount + ' shattered code blocks — run node clean.js' });
  }
  if (junkPct >= 15) {
    errors.push({ code: 'HIGH_JUNK', msg: junkPct + '% junk lines — run node clean.js' });
  }

  if (junkPct >= 5 && junkPct < 15) {
    warnings.push({ code: 'LOW_JUNK', msg: junkPct + '% possible residual junk (' + junkCount + ' lines)' });
  }
  if (h2h3Count === 0 && contentLines > 50) {
    warnings.push({ code: 'NO_HEADINGS', msg: 'No ## headings — entire file becomes one chunk' });
  }
  if (sizeKB > 300) {
    warnings.push({ code: 'LARGE_FILE', msg: sizeKB + ' KB — consider splitting for better retrieval' });
  }
  if (breadcrumbLines > 0) {
    warnings.push({ code: 'BREADCRUMBS', msg: breadcrumbLines + ' long nav/breadcrumb line(s) remaining' });
  }
  if (modalCount > 0) {
    warnings.push({ code: 'MODAL_REMNANTS', msg: modalCount + ' modal remnant(s) (× symbol) remaining' });
  }
  for (const hit of sensitiveHits) {
    warnings.push({ code: 'SENSITIVE_DATA', msg: 'Possible ' + hit.name + ' on line ' + hit.line });
  }

  return {
    file: rel, sizeKB,
    totalLines: lines.length, contentLines,
    h2h3Count, junkCount, junkPct,
    shatteredCount, estimatedChunks,
    errors, warnings,
    junkLines: SHOW_JUNK ? junkLines : [],
  };
}

function detectDuplicates(files) {
  const pairs = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = files[i].lines.filter(l => l.trim().length > 10);
      const b = files[j].lines.filter(l => l.trim().length > 10);
      if (a.length < 5 || b.length < 5) continue;
      const setA = new Set(a);
      const overlap = b.filter(l => setA.has(l)).length;
      const pct = Math.round((overlap / Math.max(a.length, b.length)) * 100);
      if (pct >= 80) pairs.push({ a: files[i].rel, b: files[j].rel, pct });
    }
  }
  return pairs;
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error('ERROR: docs/ folder not found at ' + DOCS_DIR);
    console.error('Make sure you run this from the same folder as your crawl.js');
    process.exit(1);
  }

  const filePaths = walkDir(DOCS_DIR).sort();

  if (filePaths.length === 0) {
    console.error('No .md files found in ' + DOCS_DIR);
    process.exit(1);
  }

  console.log('\nValidating ' + filePaths.length + ' files...\n');

  const analyses = filePaths.map(fp => analyzeFile(fp, path.relative(DOCS_DIR, fp)));
  const fileData = filePaths.map((fp, i) => ({
    rel: analyses[i].file,
    lines: fs.readFileSync(fp, 'utf-8').split('\n'),
  }));
  const dupes = detectDuplicates(fileData);

  if (SHOW_JUNK) {
    console.log('JUNK LINES FOUND:\n');
    for (const a of analyses) {
      if (a.junkLines.length > 0) {
        console.log('  ' + a.file + ':');
        a.junkLines.slice(0, 15).forEach(l => console.log('    | ' + l.trim()));
        if (a.junkLines.length > 15) console.log('    ... and ' + (a.junkLines.length - 15) + ' more');
      }
    }
    console.log('');
  }

  const COL = [40, 7, 7, 8, 7];
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);

  console.log(
    pad('File', COL[0]) + pad('Size', COL[1]) + pad('Lines', COL[2]) +
    pad('Chunks', COL[3]) + pad('Junk%', COL[4]) + 'Status'
  );
  console.log('-'.repeat(80));

  for (const a of analyses) {
    const label  = a.file.length > 38 ? '...' + a.file.slice(-37) : a.file;
    const status = a.errors.length   ? 'FAIL' :
                   a.warnings.length ? 'WARN' : 'OK';

    console.log(
      pad(label, COL[0]) +
      pad(a.sizeKB + 'KB', COL[1]) +
      pad(a.totalLines, COL[2]) +
      pad('~' + a.estimatedChunks, COL[3]) +
      pad(a.junkPct + '%', COL[4]) +
      status
    );

    for (const e of a.errors)   console.log('  ✗ [' + e.code + '] ' + e.msg);
    for (const w of a.warnings) console.log('  ⚠ [' + w.code + '] ' + w.msg);
  }

  const totalFiles  = analyses.length;
  const failCount   = analyses.filter(a => a.errors.length > 0).length;
  const warnCount   = analyses.filter(a => a.warnings.length > 0 && !a.errors.length).length;
  const okCount     = totalFiles - failCount - warnCount;
  const totalChunks = analyses.reduce((s, a) => s + a.estimatedChunks, 0);
  const totalSizeKB = analyses.reduce((s, a) => s + a.sizeKB, 0);

  console.log('-'.repeat(80));
  console.log(
    'Files: ' + totalFiles +
    '  |  Size: ' + (totalSizeKB / 1024).toFixed(1) + ' MB' +
    '  |  Est. chunks: ~' + totalChunks +
    '  |  OK: ' + okCount +
    '  |  Warn: ' + warnCount +
    '  |  Fail: ' + failCount
  );

  if (dupes.length > 0) {
    console.log('\nNEAR-DUPLICATE FILES:');
    dupes.forEach(d => console.log('  ' + d.a + '  <->  ' + d.b + '  (' + d.pct + '% overlap)'));
  }

  const anyErrors = failCount > 0;

  console.log('');
  if (!anyErrors && dupes.length === 0) {
    console.log('All files clean. Safe to ingest.');
  } else if (!anyErrors) {
    console.log('Warnings only — ingest is safe, but review warnings above.');
  } else if (FORCE) {
    console.log('Errors found (--force passed, continuing anyway).');
  } else {
    console.log('Errors found. Run: node clean.js   then re-run: node validate.js');
    process.exit(1);
  }

  console.log('');
}

main();
