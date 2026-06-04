// ============================================================
// OPSWAT Docs Crawler — with progress bar
// Requires ONLY: playwright (already installed)
//
// Setup:
//   npm install playwright
//   npx playwright install chromium
//
// Usage:
//   node crawl.js              <- crawl all products
//   node crawl.js cm           <- test with one product first
//   node crawl.js cm mdcore    <- crawl specific products
// ============================================================

const fs   = require('fs');
const path = require('path');

const { PRODUCTS }                                 = require('./lib/products');
const { launchBrowser, newContext }                = require('./lib/browser');
const { sleep }                                    = require('./lib/utils');
const { normalizeUrl, urlToFilename }              = require('./lib/urls');
const { extractContent, dismissBanner, isBlocked } = require('./lib/extraction');

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
const OUTPUT_DIR = process.env.SE_DOCS_DIR || './docs';
const MAX_PAGES  = Infinity;
const WAIT_MS    = 2500;

// ── Progress bar ──────────────────────────────────────────────────────────────
const BAR_WIDTH = 28;
const IS_TTY    = Boolean(process.stderr.isTTY || process.stdout.isTTY);
const WIDTH     = (process.stderr.columns || process.stdout.columns || 100) - 1;

function write(str) {
  process.stderr.write(str);
}

function makeBar(filled, total, width) {
  const pct  = total > 0 ? Math.min(filled / total, 1) : 0;
  const fill = Math.round(pct * width);
  return '[' + '#'.repeat(fill) + '-'.repeat(width - fill) + ']';
}

function truncateUrl(url, maxLen) {
  if (!url || maxLen < 10) return '';
  return url.length > maxLen ? '...' + url.slice(-(maxLen - 3)) : url;
}

class Progress {
  constructor(productSlug, totalProducts, productIndex) {
    this.slug       = productSlug;
    this.totalProd  = totalProducts;
    this.prodIdx    = productIndex;
    this.saved      = 0;
    this.skipped    = 0;
    this.errors     = 0;
    this.queueSize  = 0;
    this.visited    = 0;
    this.currentUrl = '';
    this.startTime  = Date.now();
    this._rendered  = false;

    write(`\n  [${this.prodIdx + 1}/${this.totalProd}] ${this.slug}\n`);
    if (IS_TTY) write('  \n  \n');
  }

  update({ saved, skipped, errors, queueSize, currentUrl }) {
    this.saved      = saved;
    this.skipped    = skipped;
    this.errors     = errors;
    this.queueSize  = queueSize;
    this.visited    = saved + skipped + errors;
    this.currentUrl = currentUrl;
    this._render();
  }

  _render() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);

    if (!IS_TTY) {
      if (this.saved > 0 && this.saved % 10 === 0 && !this[`_dot_${this.saved}`]) {
        this[`_dot_${this.saved}`] = true;
        write(`    ... ${this.saved} pages saved (${elapsed}s)\n`);
      }
      return;
    }

    const prodFill  = this.prodIdx;
    const prodBar   = makeBar(prodFill, this.totalProd, BAR_WIDTH);
    const prodLine  = `  Products ${prodBar} ${this.prodIdx + 1}/${this.totalProd}`;

    const totalSeen = this.visited + this.queueSize;
    const pageBar   = makeBar(this.visited, totalSeen, BAR_WIDTH);
    const stats     = `${this.saved} saved  ${this.skipped} skipped  ${this.errors} err  q:${this.queueSize}  ${elapsed}s`;
    const urlMax    = WIDTH - stats.length - 3;
    const urlPart   = urlMax > 15 ? '  ' + truncateUrl(this.currentUrl, urlMax) : '';
    const pageLine  = `  Pages    ${pageBar} ${stats}${urlPart}`;

    write('\x1B[2A');
    write('\r' + prodLine.slice(0, WIDTH).padEnd(WIDTH) + '\n');
    write('\r' + pageLine.slice(0, WIDTH).padEnd(WIDTH) + '\n');
  }

  finish(saved, skipped, errors) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    if (IS_TTY) {
      write('\x1B[2A');
      write('\r' + ' '.repeat(WIDTH) + '\n');
      write('\r' + ' '.repeat(WIDTH) + '\n');
      write('\x1B[2A');
    }
    write(`  ✓ ${this.slug.padEnd(24)} ${String(saved).padStart(4)} pages  ${skipped} skipped  ${errors} errors  (${elapsed}s)\n`);
  }
}

async function crawlProduct(context, slug, baseUrl, productIndex, totalProducts) {
  const outDir = path.join(OUTPUT_DIR, slug);
  fs.mkdirSync(outDir, { recursive: true });

  const page      = await context.newPage();
  const visited   = new Set();
  const queue     = [normalizeUrl(baseUrl)].filter(Boolean);
  let saved       = 0;
  let skipped     = 0;
  let errors      = 0;
  let bannerDone  = false;

  const progress = new Progress(slug, totalProducts, productIndex);
  progress.update({ saved, skipped, errors, queueSize: queue.length, currentUrl: baseUrl });

  while (queue.length > 0 && saved < MAX_PAGES) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    progress.update({ saved, skipped, errors, queueSize: queue.length, currentUrl: url });

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await sleep(WAIT_MS);

      if (await isBlocked(page)) {
        errors++;
        progress.update({ saved, skipped, errors, queueSize: queue.length, currentUrl: url + '  [BLOCKED]' });
        continue;
      }

      if (!bannerDone) {
        await dismissBanner(page);
        bannerDone = true;
      }

      const markdown = await extractContent(page);

      if (!markdown || markdown.length < 80) {
        skipped++;
        progress.update({ saved, skipped, errors, queueSize: queue.length, currentUrl: url });
        continue;
      }

      const filename = urlToFilename(url, baseUrl);
      const content  = `<!-- source: ${url} -->\n\n${markdown}\n`;
      fs.writeFileSync(path.join(outDir, filename), content, 'utf8');
      saved++;
      progress.update({ saved, skipped, errors, queueSize: queue.length, currentUrl: url });

      const links = await page.evaluate((base) => {
        const found = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          try {
            const abs = new URL(a.href, window.location.href).href;
            if (abs.startsWith(base)) found.add(abs);
          } catch {}
        });
        return Array.from(found);
      }, baseUrl);

      for (const raw of links) {
        const norm = normalizeUrl(raw);
        if (
          norm && !visited.has(norm) && !queue.includes(norm) &&
          !norm.includes('/undefined') &&
          !norm.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|css|js|ico|woff2?)$/i)
        ) {
          queue.push(norm);
        }
      }

    } catch (err) {
      errors++;
      progress.update({ saved, skipped, errors, queueSize: queue.length, currentUrl: url + '  [ERROR]' });
    }

    await sleep(400 + Math.random() * 400);
  }

  await page.close();
  progress.finish(saved, skipped, errors);

  return { slug, saved, skipped, errors };
}

async function main() {
  const args = process.argv.slice(2);
  let targets;

  if (args.length === 0) {
    targets = PRODUCTS;
  } else {
    const unknown = args.filter(a => !PRODUCTS.find(p => p.slug === a));
    if (unknown.length > 0) {
      console.error(`Unknown: ${unknown.join(', ')}`);
      console.error(`Available: ${PRODUCTS.map(p => p.slug).join(', ')}`);
      process.exit(1);
    }
    targets = args.map(a => PRODUCTS.find(p => p.slug === a));
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         OPSWAT Docs Crawler              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Products : ${targets.length}`);
  console.log(`  Output   : ${path.resolve(OUTPUT_DIR)}`);
  console.log(`  Max/prod : unlimited\n`);
  if (!IS_TTY) console.log('  (progress: dot printed every 10 pages)\n');

  const browser = await launchBrowser();
  const context = await newContext(browser);

  function alreadyCrawled(slug) {
    const dir = path.join(OUTPUT_DIR, slug);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).length > 0;
  }

  const toSkip  = targets.filter(t => alreadyCrawled(t.slug));
  const toCrawl = targets.filter(t => !alreadyCrawled(t.slug));

  if (toSkip.length > 0) {
    console.log('  Skipping (already crawled):');
    toSkip.forEach(t => {
      const count = fs.readdirSync(path.join(OUTPUT_DIR, t.slug)).filter(f => f.endsWith('.md')).length;
      console.log(`    ↷ ${t.slug.padEnd(26)} ${count} pages already in docs/`);
    });
    console.log('');
  }

  if (toCrawl.length === 0) {
    console.log('  All products already crawled. Nothing to do.');
    console.log('  To re-crawl a product, delete its docs/<slug>/ folder first.\n');
    await browser.close();
    return;
  }

  console.log(`  Crawling ${toCrawl.length} product(s)...\n`);

  const results = [];
  for (let i = 0; i < toCrawl.length; i++) {
    const { slug, url } = toCrawl[i];
    results.push(await crawlProduct(context, slug, url, i, toCrawl.length));
    await sleep(2000);
  }

  await browser.close();

  const totalSaved  = results.reduce((s, r) => s + r.saved, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║            Crawl Complete                ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const allOk    = results.filter(r => r.errors === 0);
  const hadErrors = results.filter(r => r.errors > 0);

  if (allOk.length)     console.log('  Completed cleanly:');
  allOk.forEach(r =>    console.log(`    ✓ ${r.slug.padEnd(26)} ${r.saved} pages`));
  if (hadErrors.length) console.log('\n  Had errors (check manually):');
  hadErrors.forEach(r => console.log(`    ⚠ ${r.slug.padEnd(26)} ${r.saved} pages (${r.errors} errors)`));

  console.log(`\n  Total pages saved : ${totalSaved}`);
  console.log(`  Output folder     : ${path.resolve(OUTPUT_DIR)}`);
  console.log('\n  Next steps:');
  console.log('    node clean.js');
  console.log('    node validate.js\n');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
