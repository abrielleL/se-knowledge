// Markdown cleaning pipeline — shared by clean.js, sync.js, and validate.js.

const EXACT_JUNK = new Set([
  'Summarize Page', 'Copy Markdown', 'Open in ChatGPT', 'Open in Claude',
  'Ask AI', 'Search this version', 'Was this page helpful?', 'SkipSend',
  'CancelOK', 'CancelOverride', 'CancelArchive', 'CancelDelete', 'CancelCreate',
  'Next to read:', 'Last updated  on', 'Expand', 'Response', 'Copy',
  'Responses application/json', 'Successful response', 'xxxxxxxxxx',
  'OAS 3', 'BearerToken', 'None', 'Auth', 'Endpoints', 'Server',
  'Server Variables', 'On This Page', '×', 'Message', 'Create', 'Edit',
  'Override', 'Archive', 'Cancel',
]);

const REGEX_JUNK = [
  /^Type to search/,
  /^\[Latest\]$/,
  /^10\.\d+\.\d+$/,
  /^\d{3}$/,
  /^Was this page helpful/,
  /^Last updated\s+on/,
  /^Next to read:/,
  /^cURL(Request|Requests|net|Guzzle|OkHttp)/,
  /^(GET|POST|PUT|DELETE|PATCH)\s*$/,
  /^oauth_/i,
  /^\*\*Summarize Page/,
  /^Summarize Page\s*\*?\*?Copy Markdown/,
];

function stripHeaderNav(text) {
  return text.split('\n').filter(line => {
    const t = line.trim();
    if (/^\[!\[/.test(t) && t.includes('Need Help')) return false;
    if (/^\[!\[/.test(t) && t.includes('opswat.com/docs')) return false;
    const linkMatches = (t.match(/\[[^\]]*\]\([^)]+\)/g) || []);
    const nonLink = t.replace(/\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)/g, '')
                     .replace(/\[[^\]]*\]\([^)]+\)/g, '')
                     .replace(/\*\*/g, '')
                     .trim();
    if (linkMatches.length >= 3 && nonLink === '') return false;
    if (linkMatches.length >= 3 && /Need Help/i.test(nonLink)) return false;
    return true;
  }).join('\n');
}

function stripModalBlocks(text) {
  return text.replace(
    /#{1,4} (Title|Create new category|Edit page index title|Edit category|Edit link|Archive Synced Block|Create new Template|Delete Template|Discard Changes)\s*\n×[\s\S]*?(?=\n---|(?=\n#{1,4} )|$)/gm,
    ''
  );
}

function stripOnThisPage(text) {
  return text.replace(/^On This Page\s*\n\[.*?\]\(.*?\)(?:\[.*?\]\(.*?\))*\s*\n/gm, '');
}

function stripDuplicateBreadcrumbs(text) {
  return text.replace(
    /^(\[(?:[^\]]*)\]\(https?:\/\/[^)]+\)(?:\[(?:[^\]]*)\]\([^)]+\))+)\n\1\n/gm,
    '$1\n'
  );
}

function stripPageNavBlock(text) {
  return text.replace(/^- Page\n- Code Steps\n- Category\n- Label\n- Link\n- Separator\n/gm, '');
}

const SUBPAGE_NAV = [
  /^\[My OPSWAT Central Management\]\(https:\/\/www\.opswat\.com\/docs\/cm\)$/,
  /^Need Help\?\s*\[Contact Support/,
  /^\[Overview\]\(\/docs\//,
  /^Getting Started$/,
  /^Deployment & Usage$/,
  /^\[Knowledge Base\].*\[Release Notes\]/,
];

function stripSubpageNav(text) {
  const parts = text.split(/(?=^---\n### Sub-page:)/m);
  return parts.map(part => {
    const lines = part.split('\n');
    return lines.filter((line, idx) => {
      if (idx < 25) return !SUBPAGE_NAV.some(p => p.test(line.trim()));
      return true;
    }).join('\n');
  }).join('');
}

function mergeShatteredCode(text) {
  const lines = text.split('\n');
  const out = [];
  let collecting = false;
  let codeLines  = [];
  let lang       = '';

  const isFence      = l => /^```/.test(l.trim());
  const getFenceLang = l => (l.trim().match(/^```(\w*)/) || [])[1] || '';
  const isCloseFence = l => l.trim() === '```';

  let i = 0;
  while (i < lines.length) {
    const curr  = lines[i];
    const next1 = lines[i + 1];
    const next2 = lines[i + 2];

    const startsBlock = isFence(curr);
    const hasOneLine  = next1 !== undefined && next1.trim() !== '' && !isFence(next1);
    const closedNext  = next2 !== undefined && isCloseFence(next2);

    if (startsBlock && hasOneLine && closedNext) {
      if (!collecting) {
        collecting = true;
        codeLines  = [];
        lang       = getFenceLang(curr);
      }
      codeLines.push(next1);
      i += 3;
      if (lines[i] !== undefined && lines[i].trim() === '') i++;
      continue;
    }

    if (collecting) {
      out.push('```' + lang);
      out.push(...codeLines);
      out.push('```');
      codeLines  = [];
      collecting = false;
      lang       = '';
    }

    out.push(curr);
    i++;
  }

  if (collecting && codeLines.length) {
    out.push('```' + lang);
    out.push(...codeLines);
    out.push('```');
  }

  return out.join('\n');
}

function stripJunkLines(text) {
  return text.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true;
    if (EXACT_JUNK.has(t)) return false;
    if (REGEX_JUNK.some(p => p.test(t))) return false;
    return true;
  }).join('\n');
}

function stripOrphanedToc(text) {
  return text.split('\n').filter(line => {
    const links   = (line.match(/\[[^\]]*\]\([^)]+\)/g) || []).length;
    const nonLink = line.replace(/\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)/g, '')
                        .replace(/\[[^\]]*\]\([^)]+\)/g, '').trim();
    return !(links >= 4 && nonLink === '');
  }).join('\n');
}

function normalizeSubpageHeaders(text) {
  return text.replace(
    /^---\n### Sub-page: (https?:\/\/[^\n]+)\n/gm,
    (_, url) => `\n<!-- source: ${url} -->\n\n`
  );
}

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanDocument(raw) {
  let text = raw;
  text = stripModalBlocks(text);
  text = stripOnThisPage(text);
  text = stripDuplicateBreadcrumbs(text);
  text = stripHeaderNav(text);
  text = stripPageNavBlock(text);
  text = stripSubpageNav(text);
  text = mergeShatteredCode(text);
  text = stripJunkLines(text);
  text = stripOrphanedToc(text);
  text = normalizeSubpageHeaders(text);
  text = collapseBlankLines(text);
  return text;
}

module.exports = {
  EXACT_JUNK,
  REGEX_JUNK,
  cleanDocument,
  // individual transforms exported for testing
  stripHeaderNav,
  stripModalBlocks,
  stripOnThisPage,
  stripDuplicateBreadcrumbs,
  stripPageNavBlock,
  stripSubpageNav,
  mergeShatteredCode,
  stripJunkLines,
  stripOrphanedToc,
  normalizeSubpageHeaders,
  collapseBlankLines,
};
