// PDF download, extraction, and markdown conversion helpers.
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

function pdfUrlToFilename(url) {
  return path.basename(url).replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
}

function pdfUrlToMdFilename(url) {
  return pdfUrlToFilename(url).replace('.pdf', '') + '.md';
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    const request = protocol.get(url, response => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    });

    request.on('error', err => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });

    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

async function extractPdfText(pdfPath) {
  let pdfjsLib;
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    throw new Error('pdfjs-dist not found. Run: npm install pdfjs-dist');
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc = '';

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false });
  const pdfDoc = await loadingTask.promise;

  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page    = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();

    let pageText = '';
    let lastY    = null;
    for (const item of content.items) {
      if ('str' in item) {
        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
          pageText += '\n';
        }
        pageText += item.str;
        lastY = item.transform[5];
      }
    }
    pageTexts.push(pageText.trim());
  }

  return pageTexts.join('\n\n---\n\n');
}

function textToMarkdown(text, sourceUrl, originalFilename) {
  const lines = text.split('\n');
  const out   = [];

  function looksLikeHeading(line) {
    const t = line.trim();
    if (!t || t.length > 100) return false;
    if (t === t.toUpperCase() && t.length > 3 && /[A-Z]/.test(t)) return true;
    if (/^\d+[\.\)]\s+[A-Z]/.test(t)) return true;
    return false;
  }

  for (const line of lines) {
    const t = line.trim();
    if (!t) { out.push(''); continue; }
    if (looksLikeHeading(t)) {
      out.push(`\n## ${t}\n`);
    } else {
      out.push(t);
    }
  }

  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `<!-- source: ${sourceUrl} -->\n<!-- file: ${originalFilename} -->\n\n${cleaned}\n`;
}

module.exports = { pdfUrlToFilename, pdfUrlToMdFilename, downloadFile, extractPdfText, textToMarkdown };
