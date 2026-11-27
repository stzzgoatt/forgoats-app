const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APP_DIR = __dirname;
const args = process.argv.slice(2);
const manifestOnly = args.includes('--manifest-only');
const noPush = args.includes('--no-push');
const bumpType = args.includes('--major') ? 'major' : (args.includes('--minor') ? 'minor' : 'patch');
const explicitVersionArg = args.find(a => a.startsWith('--version='));

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);
const IGNORED_FILES = new Set([
  'manifest.json',
  'vibranceGUI.exe',
  'vibranceGUI.zip',
  'users_db.json',
  'autologin.json',
  '.env'
]);

function walkFiles(dir, base = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      results.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name) || entry.name.endsWith('.log') || entry.name.endsWith('.tmp')) continue;
      results.push({ full, rel });
    }
  }
  return results;
}

function bumpSemver(ver, kind) {
  const parts = String(ver || '1.0.0').split('.').map(n => parseInt(n, 10) || 0);
  if (kind === 'major') return `${parts[0] + 1}.0.0`;
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function generateManifest(version) {
  const files = {};
  const list = walkFiles(APP_DIR).sort((a, b) => a.rel.localeCompare(b.rel));
  for (const f of list) {
    const buf = fs.readFileSync(f.full);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    files[f.rel] = { sha256, size: buf.length };
  }
  const manifest = {
    name: 'forgoats-app',
    version,
    publishedAt: new Date().toISOString(),
    files
  };
  fs.writeFileSync(path.join(APP_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { count: list.length, version };
}

const pkgPath = path.join(APP_DIR, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

let nextVersion = pkg.version || '1.7.1';
if (!manifestOnly) {
  nextVersion = explicitVersionArg
    ? explicitVersionArg.split('=')[1].trim()
    : bumpSemver(nextVersion, bumpType);
  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`[release] Versão atualizada em package.json -> v${nextVersion}`);
}

const { count } = generateManifest(nextVersion);
console.log(`[release] manifest.json gerado com ${count} arquivos (v${nextVersion}).`);

if (!manifestOnly && !noPush) {
  const gitBin = fs.existsSync('D:\\Git\\cmd\\git.exe') ? '"D:\\Git\\cmd\\git.exe"' : 'git';
  try {
    execSync(`${gitBin} add .`, { cwd: APP_DIR, stdio: 'inherit' });
    execSync(`${gitBin} commit -m "release: v${nextVersion}"`, { cwd: APP_DIR, stdio: 'inherit' });
    const remotes = execSync(`${gitBin} remote`, { cwd: APP_DIR }).toString().trim();
    if (remotes.split(/\r?\n/).includes('origin')) {
      execSync(`${gitBin} push origin main`, { cwd: APP_DIR, stdio: 'inherit' });
      console.log(`[release] Publicado no GitHub! Todos os usuarios receberao a v${nextVersion} automaticamente.`);
    } else {
      console.log('[release] Commit local criado! Configure o remote origin (GitHub) para publicar para todos os usuarios.');
    }
  } catch (err) {
    console.error('[release] Aviso ao rodar git:', err.message);
  }
}
