// ============================================================
// build-manifest.js — One-time indexer for existing docs/ folder
// Requires: nothing (pure Node.js built-ins only)
//
// Usage:
//   node build-manifest.js
//
// Walks docs/ recursively and writes manifest.json with one
// entry per .md file: source URL, product slug, sha256 hash,
// size, mtime, and an embedded flag for downstream Chroma use.
// ============================================================

const fs   = require('fs');
const path = require('path');

const { walkDir }       = require('./lib/utils');
const { hashBody }      = require('./lib/manifest');
const { saveManifest }  = require('./lib/manifest');

const DOCS_DIR     = process.env.SE_DOCS_DIR ? path.resolve(process.env.SE_DOCS_DIR) : path.resolve(__dirname, 'docs');
const MANIFEST_OUT = process.env.SE_MANIFEST ? path.resolve(process.env.SE_MANIFEST) : path.resolve(__dirname, 'manifest.json');
const SOURCE_RE    = /<!--\s*source:\s*(\S+)\s*-->/;

function extractSourceUrl(content) {
  const firstNewline = content.indexOf('\n');
  const line1 = firstNewline === -1 ? content : content.slice(0, firstNewline);
  const m = line1.match(SOURCE_RE);
  return m ? m[1] : null;
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error('ERROR: docs/ folder not found at ' + DOCS_DIR);
    process.exit(1);
  }

  const files = walkDir(DOCS_DIR);
  if (files.length === 0) {
    console.error('No .md files found in ' + DOCS_DIR);
    process.exit(1);
  }

  console.log('\nIndexing ' + files.length + ' .md files from ' + DOCS_DIR + '\n');

  const manifestFiles = {};
  const missingSource = [];
  const products      = new Set();
  let processed       = 0;

  for (const filePath of files.sort()) {
    const rel       = path.relative(DOCS_DIR, filePath);
    const relPosix  = rel.split(path.sep).join('/');
    const product   = relPosix.split('/')[0];
    const content   = fs.readFileSync(filePath, 'utf-8');
    const url       = extractSourceUrl(content);
    const hash      = hashBody(content);
    const stats     = fs.statSync(filePath);

    if (!url) {
      missingSource.push(relPosix);
      console.warn('  [WARN] no source URL: ' + relPosix);
    }

    products.add(product);

    manifestFiles[relPosix] = {
      url:             url,
      product:         product,
      hash:            hash,
      size:            stats.size,
      last_crawled:    stats.mtime.toISOString(),
      chroma_embedded: false,
    };

    processed++;
    if (processed % 500 === 0) {
      console.log('  ... ' + processed + ' / ' + files.length);
    }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    total_files:  files.length,
    files:        manifestFiles,
  };

  fs.writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2), 'utf-8');

  console.log('\n' + '-'.repeat(60));
  console.log('Files indexed : ' + files.length);
  console.log('Products      : ' + products.size);
  console.log('No source URL : ' + missingSource.length + ' files' +
              (missingSource.length ? ' (listed above)' : ''));
  if (missingSource.length > 0 && missingSource.length <= 20) {
    missingSource.forEach(p => console.log('                  - ' + p));
  }
  console.log('Written       : ' + path.relative(process.cwd(), MANIFEST_OUT));
  console.log('');
}

main();
