// ============================================================
// sync-pdfs.js — Differential PDF sync for OPSWAT docs
// Requires: playwright, pdfjs-dist (already installed)
//
// Crawls opswat.com/resources + product pages, finds PDFs on
// static.opswat.com, and downloads + extracts only the ones
// not already tracked in manifest.json.
//
// Usage:
//   node sync-pdfs.js              <- check for and download new PDFs
//   node sync-pdfs.js --dry-run    <- preview only
//   node sync-pdfs.js --find-only  <- list new PDF URLs only
// ============================================================

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const { CRAWL_TARGETS, PDF_HOST }                              = require('./lib/products');
const { sleep }                                                = require('./lib/utils');
const { pdfUrlToFilename, pdfUrlToMdFilename, downloadFile,
        extractPdfText, textToMarkdown }                       = require('./lib/pdf');
const { hashBody, loadManifest, saveManifest }                 = require('./lib/manifest');

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
const PDF_DIR       = process.env.SE_PDF_DIR      || './pdfs';
const DOCS_DIR      = process.env.SE_PDF_DOCS_DIR || './docs/pdfs';
const MANIFEST_PATH = process.env.SE_MANIFEST     || './manifest.json';
const WAIT_MS       = 1500;

const DRY_RUN   = process.argv.includes('--dry-run');
const FIND_ONLY = process.argv.includes('--find-only');

function write(str) {
  process.stderr.write(str);
}

async function discoverPdfs(browser) {
  write('\n📄  Discovering PDFs across OPSWAT pages...\n\n');

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page    = await context.newPage();
  const pdfUrls = new Map();

  for (let i = 0; i < CRAWL_TARGETS.length; i++) {
    const pageUrl = CRAWL_TARGETS[i];
    write(`  [${i + 1}/${CRAWL_TARGETS.length}] ${pageUrl}\r`);

    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(WAIT_MS);

      const links = await page.evaluate((pdfHost) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({
            href:  a.href,
            title: (a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim(),
          }))
          .filter(({ href }) =>
            href.includes(pdfHost) && href.toLowerCase().endsWith('.pdf')
          );
      }, PDF_HOST);

      for (const { href, title } of links) {
        if (!pdfUrls.has(href)) {
          pdfUrls.set(href, { sourcePageUrl: pageUrl, title });
        }
      }

      write(`  [${i + 1}/${CRAWL_TARGETS.length}] ${pageUrl} → ${links.length} PDFs\n`);
    } catch (err) {
      write(`  [${i + 1}/${CRAWL_TARGETS.length}] ERROR: ${err.message}\n`);
    }

    await sleep(500);
  }

  await page.close();
  await context.close();

  write(`\n  ✓ Discovered ${pdfUrls.size} unique PDFs\n`);
  return pdfUrls;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         OPSWAT PDF Sync                  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  PDF folder    : ${PDF_DIR}`);
  console.log(`  Markdown out  : ${DOCS_DIR}`);
  console.log(`  Manifest      : ${MANIFEST_PATH}`);
  console.log(`  Mode          : ${DRY_RUN ? 'DRY RUN' : FIND_ONLY ? 'FIND ONLY' : 'WRITE'}\n`);

  const manifest = loadManifest(MANIFEST_PATH, { allowMissing: true });

  const knownPdfs = new Set();
  for (const entry of Object.values(manifest.files)) {
    if (entry.product === 'pdfs' && entry.url) {
      knownPdfs.add(entry.url);
    }
  }
  console.log(`  Known PDFs    : ${knownPdfs.size}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let discovered;
  try {
    discovered = await discoverPdfs(browser);
  } finally {
    await browser.close();
  }

  const newPdfs = [];
  for (const [url, meta] of discovered) {
    if (!knownPdfs.has(url)) newPdfs.push({ url, ...meta });
  }
  const skippedCount = discovered.size - newPdfs.length;

  if (newPdfs.length === 0) {
    console.log(`\n  No new PDFs found. (${knownPdfs.size} known)\n`);
    return;
  }

  console.log(`\n  New PDFs      : ${newPdfs.length}`);
  console.log(`  Already known : ${skippedCount}`);

  if (FIND_ONLY) {
    console.log('\nNew PDF URLs:');
    for (const { url, sourcePageUrl, title } of newPdfs) {
      console.log(`  ${url}`);
      if (title) console.log(`    Title: ${title}`);
      console.log(`    From:  ${sourcePageUrl}`);
    }
    console.log(`\nTotal new: ${newPdfs.length}`);
    console.log('Run without --find-only to download and extract.\n');
    return;
  }

  fs.mkdirSync(PDF_DIR,  { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const newFiles = [];
  let errors     = 0;

  for (let i = 0; i < newPdfs.length; i++) {
    const { url } = newPdfs[i];
    const filename = pdfUrlToFilename(url);
    const pdfPath  = path.join(PDF_DIR, filename);
    const mdName   = pdfUrlToMdFilename(url);
    const mdPath   = path.join(DOCS_DIR, mdName);
    const relPath  = 'pdfs/' + mdName;

    write(`\n  [${i + 1}/${newPdfs.length}] ${filename}\n`);

    if (DRY_RUN) {
      write(`    (dry run) would download ${url}\n`);
      write(`    (dry run) would write    ${relPath}\n`);
      newFiles.push(relPath);
      continue;
    }

    try {
      if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000) {
        write(`    ↷ pdf already on disk, reusing\n`);
      } else {
        await downloadFile(url, pdfPath);
        const sizeKB = Math.round(fs.statSync(pdfPath).size / 1024);
        write(`    ✓ downloaded (${sizeKB} KB)\n`);
      }

      const text     = await extractPdfText(pdfPath);
      const markdown = textToMarkdown(text, url, filename);

      if (markdown.length < 200) {
        write(`    ✗ extracted text too short, skipping\n`);
        errors++;
        continue;
      }

      fs.writeFileSync(mdPath, markdown, 'utf-8');
      const stats = fs.statSync(mdPath);
      const hash  = hashBody(markdown);

      manifest.files[relPath] = {
        url:             url,
        product:         'pdfs',
        hash:            hash,
        size:            stats.size,
        last_crawled:    new Date().toISOString(),
        chroma_embedded: false,
      };

      newFiles.push(relPath);
      const words = text.split(/\s+/).length;
      write(`    ✓ extracted ${relPath} (~${words} words)\n`);
    } catch (err) {
      errors++;
      write(`    ✗ ${err.message}\n`);
    }

    await sleep(500);
  }

  if (!DRY_RUN) {
    saveManifest(manifest, MANIFEST_PATH);

    const report = {
      sync_at:   new Date().toISOString(),
      new_pdfs:  newFiles.length,
      skipped:   skippedCount,
      errors:    errors,
      new_files: newFiles,
    };
    fs.writeFileSync('./sync-pdfs-report.json', JSON.stringify(report, null, 2), 'utf-8');
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`  ✓  ${newFiles.length} new PDFs downloaded and extracted`);
  console.log(`  =  ${skippedCount} already known, skipped`);
  console.log(`  ✗  ${errors} errors`);
  if (newFiles.length > 0) {
    console.log('\n  New files:');
    for (const f of newFiles.slice(0, 20)) console.log(`    + ${f}`);
    if (newFiles.length > 20) console.log(`    ... and ${newFiles.length - 20} more`);
  }
  if (DRY_RUN) {
    console.log('\n  (dry run — manifest and report not written)');
  } else {
    console.log('\n  Sync report written to sync-pdfs-report.json');
    console.log('  Run: node ingest.js --changed-only');
  }
  console.log('');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
