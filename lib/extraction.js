// Page content extraction helpers for Playwright-based crawlers.
const { sleep } = require('./utils');

const CONTENT_SELECTORS = [
  'article', 'main',
  '[class*="content-body"]', '[class*="doc-content"]',
  '[class*="page-content"]', '#main-content', '.markdown-body',
];

const STRIP_SELECTORS = [
  'nav', 'header', 'footer',
  '[class*="sidebar"]', '[class*="navbar"]', '[class*="breadcrumb"]',
  '[class*="cookie"]', '[class*="consent"]', '[class*="OneTrust"]',
  '[id*="onetrust"]', '[class*="banner"]', '[class*="modal"]',
  '[class*="overlay"]', '[class*="feedback"]', '[class*="search"]',
  '[class*="pagination"]', '[class*="prev-next"]',
  'script', 'style', 'noscript', 'iframe',
];

// In-browser HTML → Markdown converter (serialized and sent to page.evaluate)
function htmlToMarkdown(el) {
  function process(node, depth) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const tag      = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes).map(n => process(n, depth)).join('');
    if (['script','style','noscript','iframe'].includes(tag)) return '';
    if (tag === 'h1') return `\n\n# ${node.textContent.trim()}\n\n`;
    if (tag === 'h2') return `\n\n## ${node.textContent.trim()}\n\n`;
    if (tag === 'h3') return `\n\n### ${node.textContent.trim()}\n\n`;
    if (tag === 'h4') return `\n\n#### ${node.textContent.trim()}\n\n`;
    if (tag === 'h5') return `\n\n##### ${node.textContent.trim()}\n\n`;
    if (tag === 'h6') return `\n\n###### ${node.textContent.trim()}\n\n`;
    if (tag === 'p')  return `\n\n${children()}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'strong' || tag === 'b') return `**${children()}**`;
    if (tag === 'em'     || tag === 'i') return `*${children()}*`;
    if (tag === 'code' && node.parentElement.tagName.toLowerCase() !== 'pre') {
      return `\`${node.textContent}\``;
    }
    if (tag === 'pre') {
      const code = node.querySelector('code');
      const lang = code ? (code.className.match(/language-(\w+)/) || [])[1] || '' : '';
      return `\n\n\`\`\`${lang}\n${(code || node).textContent}\n\`\`\`\n\n`;
    }
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const text = children().trim();
      if (!text) return '';
      if (!href || href.startsWith('#')) return text;
      return `[${text}](${href})`;
    }
    if (tag === 'img') {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      return src ? `![${alt}](${src})` : '';
    }
    if (tag === 'ul') {
      return '\n\n' + Array.from(node.children)
        .map(li => `- ${process(li, depth+1).trim()}`).join('\n') + '\n\n';
    }
    if (tag === 'ol') {
      return '\n\n' + Array.from(node.children)
        .map((li, i) => `${i+1}. ${process(li, depth+1).trim()}`).join('\n') + '\n\n';
    }
    if (tag === 'li') return children();
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'));
      if (!rows.length) return '';
      const toRow = cells => '| ' + cells.map(c => c.textContent.trim().replace(/\|/g,'\\|')).join(' | ') + ' |';
      const hCells = Array.from(rows[0].querySelectorAll('th,td'));
      const header  = toRow(hCells);
      const divider = '| ' + hCells.map(() => '---').join(' | ') + ' |';
      const body    = rows.slice(1).map(r => toRow(Array.from(r.querySelectorAll('td,th')))).join('\n');
      return `\n\n${header}\n${divider}\n${body}\n\n`;
    }
    if (tag === 'blockquote') return `\n\n> ${children().trim().replace(/\n/g,'\n> ')}\n\n`;
    return children();
  }
  return process(el, 0);
}

async function extractContent(page) {
  await page.evaluate((sels) => {
    sels.forEach(sel => {
      try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
    });
  }, STRIP_SELECTORS);

  const markdown = await page.evaluate(
    ({ contentSels, fn }) => {
      let el = null;
      for (const sel of contentSels) { el = document.querySelector(sel); if (el) break; }
      if (!el) el = document.body;
      if (!el) return null;
      const convert = new Function('el', `return (${fn})(el)`);
      return convert(el);
    },
    { contentSels: CONTENT_SELECTORS, fn: htmlToMarkdown.toString() }
  );

  if (!markdown) return null;
  return markdown.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
}

async function dismissBanner(page) {
  const btns = [
    '#onetrust-reject-all-handler',
    'button:text("Reject All")',
    'button:text("Decline All")',
    '[aria-label*="reject" i]',
  ];
  for (const sel of btns) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await sleep(800);
        return;
      }
    } catch {}
  }
}

async function isBlocked(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '');
    return text.includes('403') || text.includes('Request blocked') || text.includes('CloudFront');
  } catch { return false; }
}

module.exports = {
  CONTENT_SELECTORS,
  STRIP_SELECTORS,
  htmlToMarkdown,
  extractContent,
  dismissBanner,
  isBlocked,
};
