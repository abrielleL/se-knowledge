// ============================================================
// crawl-pdfs.js — OPSWAT PDF Harvester
// Crawls opswat.com pages, finds all PDF links on static.opswat.com,
// downloads them, extracts text, and saves as .md files ready for ingest.
//
// Requires:
//   npm install playwright pdfjs-dist
//   npx playwright install chromium
//
// Usage:
//   node crawl-pdfs.js              <- crawl all pages + download all PDFs
//   node crawl-pdfs.js --find-only  <- just find PDF URLs, don't download
//   node crawl-pdfs.js --extract    <- extract text from already-downloaded PDFs
// ============================================================

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const { CRAWL_TARGETS, PDF_HOST }                              = require('./lib/products');
const { sleep }                                                = require('./lib/utils');
const { pdfUrlToFilename, pdfUrlToMdFilename, downloadFile,
        extractPdfText, textToMarkdown }                       = require('./lib/pdf');

const FIND_ONLY = process.argv.includes('--find-only');
const EXTRACT   = process.argv.includes('--extract');

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
const PDF_DIR  = process.env.SE_PDF_DIR      || './pdfs';
const DOCS_DIR = process.env.SE_PDF_DOCS_DIR || './docs/pdfs';
const WAIT_MS  = 1500;

function write(str) {
  process.stderr.write(str);
}

// ── Phase 1: Crawl pages and collect PDF links ────────────────────────────────
async function findPdfLinks(browser) {
  write('\n📄  Phase 1: Finding PDF links across OPSWAT pages...\n\n');

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

      write(`  [${i + 1}/${CRAWL_TARGETS.length}] ${pageUrl} → ${links.length} PDFs found\n`);
    } catch (err) {
      write(`  [${i + 1}/${CRAWL_TARGETS.length}] ERROR: ${err.message}\n`);
    }

    await sleep(500);
  }

  await page.close();
  await context.close();

  write(`\n  ✓ Found ${pdfUrls.size} unique PDFs\n`);
  return pdfUrls;
}

// ── Phase 2: Download PDFs ─────────────────────────────────────────────────────
async function downloadPdfs(pdfUrls) {
  write('\n⬇️   Phase 2: Downloading PDFs...\n\n');

  fs.mkdirSync(PDF_DIR, { recursive: true });

  const manifest = Object.fromEntries(
    Array.from(pdfUrls.entries()).map(([url, meta]) => [url, meta])
  );
  fs.writeFileSync(path.join(PDF_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2));

  let downloaded = 0;
  let skipped    = 0;
  let errors     = 0;
  let i          = 0;

  for (const [url, { title }] of pdfUrls) {
    i++;
    const filename = pdfUrlToFilename(url);
    const destPath = path.join(PDF_DIR, filename);

    write(`  [${i}/${pdfUrls.size}] ${filename}\r`);

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
      skipped++;
      write(`  [${i}/${pdfUrls.size}] ↷ ${filename} (already downloaded)\n`);
      continue;
    }

    try {
      await downloadFile(url, destPath);
      const sizeKB = Math.round(fs.statSync(destPath).size / 1024);
      downloaded++;
      write(`  [${i}/${pdfUrls.size}] ✓ ${filename} (${sizeKB} KB)\n`);
    } catch (err) {
      errors++;
      write(`  [${i}/${pdfUrls.size}] ✗ ${filename} — ${err.message}\n`);
    }

    await sleep(300);
  }

  write(`\n  ✓ Downloaded: ${downloaded}  Skipped: ${skipped}  Errors: ${errors}\n`);
}

// ── Phase 3: Extract text from PDFs → markdown ────────────────────────────────
async function extractAllPdfs(pdfUrls) {
  write('\n📝  Phase 3: Extracting text from PDFs...\n\n');

  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const pdfFiles = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));

  const filenameToUrl = new Map();
  for (const [url] of pdfUrls) {
    filenameToUrl.set(pdfUrlToFilename(url), url);
  }

  let extracted = 0;
  let skipped   = 0;
  let errors    = 0;

  for (let i = 0; i < pdfFiles.length; i++) {
    const filename = pdfFiles[i];
    const pdfPath  = path.join(PDF_DIR, filename);
    const mdPath   = path.join(DOCS_DIR, pdfUrlToMdFilename(
      filenameToUrl.get(filename) || filename
    ));

    write(`  [${i + 1}/${pdfFiles.length}] ${filename}\r`);

    if (fs.existsSync(mdPath)) {
      skipped++;
      write(`  [${i + 1}/${pdfFiles.length}] ↷ ${filename} (already extracted)\n`);
      continue;
    }

    try {
      const text      = await extractPdfText(pdfPath);
      const sourceUrl = filenameToUrl.get(filename) || `file://${pdfPath}`;
      const markdown  = textToMarkdown(text, sourceUrl, filename);

      if (markdown.length < 200) {
        write(`  [${i + 1}/${pdfFiles.length}] ↷ ${filename} — too short, skipping\n`);
        skipped++;
        continue;
      }

      fs.writeFileSync(mdPath, markdown, 'utf-8');
      extracted++;

      const words = text.split(/\s+/).length;
      write(`  [${i + 1}/${pdfFiles.length}] ✓ ${filename} (~${words} words)\n`);
    } catch (err) {
      errors++;
      write(`  [${i + 1}/${pdfFiles.length}] ✗ ${filename} — ${err.message}\n`);
    }
  }

  write(`\n  ✓ Extracted: ${extracted}  Skipped: ${skipped}  Errors: ${errors}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         OPSWAT PDF Harvester             ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  PDF downloads : ${PDF_DIR}`);
  console.log(`  Markdown out  : ${DOCS_DIR}`);

  fs.mkdirSync(PDF_DIR,  { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  if (EXTRACT) {
    console.log('\n  Mode: extract only (using existing PDFs in ' + PDF_DIR + ')\n');
    const manifestPath = path.join(PDF_DIR, '_manifest.json');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      : {};
    const pdfUrls = new Map(Object.entries(manifest));
    await extractAllPdfs(pdfUrls);
    console.log('\n  Done. Run: node clean.js && node validate.js\n');
    return;
  }

  console.log(`\n  Pages to crawl: ${CRAWL_TARGETS.length}`);
  console.log(`  PDF source    : ${PDF_HOST}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let pdfUrls;
  try {
    pdfUrls = await findPdfLinks(browser);
  } finally {
    await browser.close();
  }

  if (FIND_ONLY) {
    console.log('\nPDF URLs found:');
    for (const [url, { sourcePageUrl, title }] of pdfUrls) {
      console.log(`  ${url}`);
      if (title) console.log(`    Title: ${title}`);
      console.log(`    From:  ${sourcePageUrl}`);
    }
    console.log(`\nTotal: ${pdfUrls.size} PDFs`);
    console.log('Run without --find-only to download and extract.\n');
    return;
  }

  await downloadPdfs(pdfUrls);
  await extractAllPdfs(pdfUrls);

  const mdFiles  = fs.existsSync(DOCS_DIR)
    ? fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md')).length
    : 0;
  const pdfFiles = fs.existsSync(PDF_DIR)
    ? fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf')).length
    : 0;

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║              Harvest Complete            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  PDFs downloaded : ${pdfFiles}`);
  console.log(`  Markdown files  : ${mdFiles}`);
  console.log(`  PDF folder      : ${path.resolve(PDF_DIR)}`);
  console.log(`  Docs folder     : ${path.resolve(DOCS_DIR)}`);
  console.log('\n  Next steps:');
  console.log('    node clean.js');
  console.log('    node validate.js');
  console.log('    (then proceed to ingest)\n');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
