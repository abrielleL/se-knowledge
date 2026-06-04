const fs   = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function walkDir(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())             walkDir(full, results);
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

module.exports = { sleep, walkDir };
