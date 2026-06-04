function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = ''; u.search = '';
    let r = u.toString();
    if (r.endsWith('/')) r = r.slice(0, -1);
    return r;
  } catch { return null; }
}

function urlToFilename(pageUrl, baseUrl) {
  const relative = pageUrl.replace(baseUrl, '').replace(/^\//, '') || 'index';
  return relative
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180) + '.md';
}

module.exports = { normalizeUrl, urlToFilename };
