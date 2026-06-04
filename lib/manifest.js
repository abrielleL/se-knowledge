// Manifest read/write helpers and content hashing.
const fs     = require('fs');
const crypto = require('crypto');

function hashContent(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Strips the <!-- source: --> header line before hashing, matching build-manifest.js
// behavior so first sync after manifest rebuild converges.
function hashBody(content) {
  const lines = content.split('\n');
  const body  = lines.length > 0 && /<!--\s*source:/.test(lines[0])
                  ? lines.slice(1).join('\n')
                  : content;
  return hashContent(body);
}

function loadManifest(manifestPath, { allowMissing = false } = {}) {
  if (!fs.existsSync(manifestPath)) {
    if (allowMissing) {
      return { generated_at: new Date().toISOString(), total_files: 0, files: {} };
    }
    console.error('ERROR: manifest.json not found at ' + manifestPath);
    console.error('Run: node build-manifest.js');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.error('ERROR: failed to parse manifest.json — ' + err.message);
    process.exit(1);
  }
}

function saveManifest(manifest, manifestPath) {
  manifest.generated_at = new Date().toISOString();
  manifest.total_files  = Object.values(manifest.files).filter(e => e.status !== 'deleted').length;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

module.exports = { hashContent, hashBody, loadManifest, saveManifest };
