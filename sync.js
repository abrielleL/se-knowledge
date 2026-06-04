// ============================================================
// sync.js — Differential OPSWAT docs crawler
// Requires: playwright (already installed)
//
// Re-crawls opswat.com/docs live, compares against manifest.json,
// and applies only the delta (new / changed / deleted pages).
//
// Usage:
//   node sync.js                        <- sync all (30-day staleness)
//   node sync.js --dry-run              <- preview only
//   node sync.js --product=mdcore       <- one product
//   node sync.js --release-notes        <- release note pages only
//   node sync.js --stale-days=7         <- tighter staleness window
//   node sync.js --force-full           <- re-fetch all known pages
//
// Prerequisite:
//   node build-manifest.js              <- creates manifest.json
// ============================================================

const fs   = require('fs');
const path = require('path');

const { PRODUCTS }                                 = require('./lib/products');
const { launchBrowser, newContext }                = require('./lib/browser');
const { sleep }                                    = require('./lib/utils');
const { normalizeUrl, urlToFilename }              = require('./lib/urls');
const { extractContent, dismissBanner, isBlocked } = require('./lib/extraction');
const { cleanDocument }                            = require('./lib/clean');
const { hashContent, loadManifest, saveManifest }  = require('./lib/manifest');

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
const DOCS_DIR      = process.env.SE_DOCS_DIR ? path.resolve(process.env.SE_DOCS_DIR) : path.resolve(__dirname, 'docs');
const MANIFEST_PATH = process.env.SE_MANIFEST ? path.resolve(process.env.SE_MANIFEST) : path.resolve(__dirname, 'manifest.json');
const REPORT_PATH   = path.resolve(__dirname, 'sync-report.json');

let STALE_DAYS = 30;
const WAIT_MS  = 1500;

function parseCliFlags() {
  const flags = {
    dryRun:       false,
    product:      null,
    releaseNotes: false,
    forceFull:    false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run')               flags.dryRun = true;
    else if (arg === '--release-notes')    flags.releaseNotes = true;
    else if (arg === '--force-full')       flags.forceFull = true;
    else if (arg.startsWith('--product=')) flags.product = arg.slice('--product='.length);
    else if (arg.startsWith('--stale-days=')) {
      const n = parseInt(arg.slice('--stale-days='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error('ERROR: --stale-days must be a non-negative integer');
        process.exit(1);
      }
      STALE_DAYS = n;
    } else {
      console.error('ERROR: unknown flag: ' + arg);
      process.exit(1);
    }
  }
  return flags;
}

function isReleaseNoteUrl(url) {
  const lower = url.toLowerCase();
  return lower.includes('release') || lower.includes('changelog');
}

async function discoverProduct(context, baseUrl) {
  const page    = await context.newPage();
  const visited = new Set();
  const queue   = [normalizeUrl(baseUrl)].filter(Boolean);
  const found   = new Set();
  let bannerDone = false;

  while (queue.length > 0) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await sleep(WAIT_MS);

      if (await isBlocked(page)) continue;

      if (!bannerDone) {
        await dismissBanner(page);
        bannerDone = true;
      }

      found.add(url);

      const links = await page.evaluate((base) => {
        const acc = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          try {
            const abs = new URL(a.href, window.location.href).href;
            if (abs.startsWith(base)) acc.add(abs);
          } catch {}
        });
        return Array.from(acc);
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
    } catch {
      // skip and continue
    }

    await sleep(400 + Math.random() * 400);
  }

  await page.close();
  return found;
}

async function fetchAndExtract(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await sleep(WAIT_MS);
    if (await isBlocked(page)) return { error: 'blocked' };
    const markdown = await extractContent(page);
    if (!markdown || markdown.length < 80) return { error: 'too_short' };
    return { markdown };
  } catch (err) {
    return { error: err.message };
  } finally {
    await page.close();
  }
}

async function main() {
  const startTime = Date.now();
  const flags     = parseCliFlags();
  const manifest  = loadManifest(MANIFEST_PATH);

  let targets = PRODUCTS;
  if (flags.product) {
    const found = PRODUCTS.find(p => p.slug === flags.product);
    if (!found) {
      console.error('ERROR: unknown product: ' + flags.product);
      console.error('Available: ' + PRODUCTS.map(p => p.slug).join(', '));
      process.exit(1);
    }
    targets = [found];
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         OPSWAT Docs Sync                 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('\n  Products      : ' + targets.length);
  console.log('  Stale days    : ' + STALE_DAYS);
  console.log('  Mode          : ' + (flags.dryRun ? 'DRY RUN' : 'WRITE'));
  if (flags.releaseNotes) console.log('  Filter        : release notes only');
  if (flags.forceFull)    console.log('  Force         : re-fetching all known pages');
  console.log('');

  const browser = await launchBrowser();
  const context = await newContext(browser);

  const manifestByUrl = {};
  for (const [relPath, entry] of Object.entries(manifest.files)) {
    if (entry.url) manifestByUrl[entry.url] = { relPath, entry };
  }

  const now           = Date.now();
  const staleCutoff   = now - STALE_DAYS * 24 * 60 * 60 * 1000;
  const productsSynced = [];
  const changedFiles  = [];
  const deletedFiles  = [];
  let newPages       = 0;
  let updatedPages   = 0;
  let unchangedPages = 0;
  let deletedPages   = 0;
  let errorCount     = 0;

  for (const { slug, url: baseUrl } of targets) {
    console.log('\n  [' + slug + '] discovery...');
    productsSynced.push(slug);

    let discovered;
    try {
      discovered = await discoverProduct(context, baseUrl);
    } catch (err) {
      console.error('    discovery failed: ' + err.message);
      errorCount++;
      continue;
    }
    console.log('    discovered ' + discovered.size + ' urls');

    const manifestUrlsForProduct = new Set();
    for (const entry of Object.values(manifest.files)) {
      if (entry.product === slug && entry.url && entry.status !== 'deleted') {
        manifestUrlsForProduct.add(entry.url);
      }
    }

    let new_urls    = [];
    let stale_urls  = [];
    let fresh_count = 0;
    let deleted_urls = [];

    for (const url of discovered) {
      const known = manifestByUrl[url];
      if (!known || known.entry.product !== slug || known.entry.status === 'deleted') {
        new_urls.push(url);
        continue;
      }
      const lastMs = Date.parse(known.entry.last_crawled);
      if (flags.forceFull || !Number.isFinite(lastMs) || lastMs < staleCutoff) {
        stale_urls.push(url);
      } else {
        fresh_count++;
      }
    }

    for (const url of manifestUrlsForProduct) {
      if (!discovered.has(url)) deleted_urls.push(url);
    }

    if (flags.releaseNotes) {
      new_urls     = new_urls.filter(isReleaseNoteUrl);
      stale_urls   = stale_urls.filter(isReleaseNoteUrl);
      deleted_urls = deleted_urls.filter(isReleaseNoteUrl);
    }

    console.log('    new: ' + new_urls.length +
                '  stale: ' + stale_urls.length +
                '  fresh: ' + fresh_count +
                '  deleted: ' + deleted_urls.length);

    const toFetch = [...new_urls, ...stale_urls];
    for (let i = 0; i < toFetch.length; i++) {
      const pageUrl = toFetch[i];
      const isNew   = !manifestByUrl[pageUrl] || manifestByUrl[pageUrl].entry.product !== slug
                                              || manifestByUrl[pageUrl].entry.status === 'deleted';

      const result = await fetchAndExtract(context, pageUrl);
      if (result.error) {
        console.log('    [' + (i + 1) + '/' + toFetch.length + '] ⚠  ' + result.error + ' — ' + pageUrl);
        errorCount++;
        await sleep(800 + Math.random() * 400);
        continue;
      }

      const rawMarkdown = result.markdown;
      const rawHash     = hashContent(rawMarkdown);

      if (!isNew) {
        const known = manifestByUrl[pageUrl];
        if (known.entry.hash === rawHash) {
          unchangedPages++;
          if (!flags.dryRun) {
            known.entry.last_crawled = new Date().toISOString();
          }
          await sleep(800 + Math.random() * 400);
          continue;
        }
      }

      const fileContent = '<!-- source: ' + pageUrl + ' -->\n\n' + rawMarkdown + '\n';
      const cleaned     = cleanDocument(fileContent);
      const filename    = urlToFilename(pageUrl, baseUrl);
      const relPath     = slug + '/' + filename;
      const absPath     = path.join(DOCS_DIR, slug, filename);

      if (!flags.dryRun) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, cleaned, 'utf-8');
        const stats = fs.statSync(absPath);
        manifest.files[relPath] = {
          url:             pageUrl,
          product:         slug,
          hash:            rawHash,
          size:            stats.size,
          last_crawled:    new Date().toISOString(),
          chroma_embedded: false,
        };
        manifestByUrl[pageUrl] = { relPath, entry: manifest.files[relPath] };
      }

      if (isNew) {
        newPages++;
        console.log('    [' + (i + 1) + '/' + toFetch.length + '] +  ' + relPath);
      } else {
        updatedPages++;
        console.log('    [' + (i + 1) + '/' + toFetch.length + '] ~  ' + relPath);
      }
      changedFiles.push(relPath);

      await sleep(800 + Math.random() * 400);
    }

    for (const url of deleted_urls) {
      const known = manifestByUrl[url];
      if (!known) continue;
      const absPath = path.join(DOCS_DIR, known.relPath);
      if (!flags.dryRun) {
        if (fs.existsSync(absPath)) {
          try { fs.unlinkSync(absPath); } catch {}
        }
        known.entry.status     = 'deleted';
        known.entry.deleted_at = new Date().toISOString();
      }
      deletedPages++;
      deletedFiles.push(known.relPath);
      console.log('    ✗  ' + known.relPath);
    }
  }

  await browser.close();

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  const report = {
    sync_at:          new Date().toISOString(),
    duration_seconds: durationSec,
    products_synced:  productsSynced,
    new_pages:        newPages,
    updated_pages:    updatedPages,
    unchanged_pages:  unchangedPages,
    deleted_pages:    deletedPages,
    errors:           errorCount,
    changed_files:    changedFiles,
    deleted_files:    deletedFiles,
  };

  if (flags.dryRun) {
    console.log('\n  (dry run — manifest and report not written)');
  } else {
    saveManifest(manifest, MANIFEST_PATH);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  }

  console.log('\n' + '-'.repeat(60));
  console.log('  ✓  ' + newPages       + ' new pages added');
  console.log('  ~  ' + updatedPages   + ' pages updated (content changed)');
  console.log('  =  ' + unchangedPages + ' pages unchanged (hash match)');
  console.log('  ✗  ' + deletedPages   + ' pages deleted');
  console.log('  ⚠  ' + errorCount     + ' errors');
  if (changedFiles.length > 0) {
    console.log('\n  Changed files:');
    for (const f of changedFiles.slice(0, 20)) {
      const prefix = deletedFiles.includes(f) ? '~' : '+';
      console.log('    ' + prefix + ' ' + f);
    }
    if (changedFiles.length > 20) console.log('    ... and ' + (changedFiles.length - 20) + ' more');
  }
  if (!flags.dryRun) {
    console.log('\n  Sync report written to sync-report.json');
    console.log('  Run: node ingest.js --changed-only');
  }
  console.log('');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
