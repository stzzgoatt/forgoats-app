const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return sha256Buffer(fs.readFileSync(filePath));
  } catch (e) {
    return null;
  }
}

function compareSemver(a, b) {
  const pa = String(a || '0.0.0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0.0.0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function getLocalVersion(appDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch (e) {
    return '1.0.0';
  }
}

function getUpdateConfig(appDir) {
  const defaults = {
    enabled: true,
    githubOwner: 'stzzgoatt',
    githubRepo: 'forgoats-app',
    githubBranch: 'main',
    manifestUrl: '',
    checkOnStartup: true,
    checkIntervalMinutes: 30,
    autoRestart: true
  };
  try {
    const cfgPath = path.join(appDir, 'update-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object') Object.assign(defaults, parsed);
    }
  } catch (e) {}

  if (process.env.FORGOATS_MANIFEST_URL && process.env.FORGOATS_MANIFEST_URL.trim()) {
    defaults.manifestUrl = process.env.FORGOATS_MANIFEST_URL.trim();
  }
  return defaults;
}

function resolveBaseUrls(config) {
  if (config.manifestUrl && config.manifestUrl.trim()) {
    const manifestUrl = config.manifestUrl.trim();
    const baseUrl = manifestUrl.replace(/\/[^/]*$/, '/');
    return { manifestUrl, baseUrl };
  }
  const owner = encodeURIComponent(String(config.githubOwner || '').trim());
  const repo = encodeURIComponent(String(config.githubRepo || '').trim());
  const branch = encodeURIComponent(String(config.githubBranch || 'main').trim());
  if (!owner || !repo) return null;
  const baseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`;
  return { manifestUrl: `${baseUrl}manifest.json`, baseUrl };
}

function isSafeRelativePath(appDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return false;
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.includes('..') || norm.startsWith('.git/') || norm === '.git' || norm.startsWith('node_modules/')) {
    return false;
  }
  const resolved = path.resolve(appDir, norm);
  const rootResolved = path.resolve(appDir);
  return resolved.startsWith(rootResolved + path.sep);
}

function fetchBuffer(rawUrl, timeoutMs = 12000, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 5) return reject(new Error('Muitos redirecionamentos.'));
    let parsed;
    try {
      parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error('Protocolo de atualização inválido.'));
      }
    } catch (err) {
      return reject(new Error('URL de atualização inválida.'));
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(
      parsed,
      {
        headers: {
          'User-Agent': 'ForGoats-AutoUpdater/1.0',
          'Cache-Control': 'no-cache'
        },
        timeout: timeoutMs
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          return resolve(fetchBuffer(nextUrl, timeoutMs, redirectDepth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );

    req.on('timeout', () => req.destroy(new Error('Tempo esgotado ao buscar atualização.')));
    req.on('error', reject);
  });
}

function writeFileAtomic(targetPath, buffer) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.update.tmp`;
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, targetPath);
}

async function checkAndApplyUpdates({ appDir, onStatus = () => {}, force = false } = {}) {
  const currentVersion = getLocalVersion(appDir);
  const config = getUpdateConfig(appDir);

  if (!config.enabled) {
    const info = { state: 'disabled', currentVersion, message: 'Atualização automática desativada.' };
    onStatus(info);
    return { updated: false, ...info };
  }

  const urls = resolveBaseUrls(config);
  if (!urls) {
    const info = { state: 'error', currentVersion, message: 'Repositório de atualização não configurado.' };
    onStatus(info);
    return { updated: false, ...info };
  }

  onStatus({ state: 'checking', currentVersion, message: 'Verificando atualizações...' });

  let remoteManifest;
  try {
    const buf = await fetchBuffer(`${urls.manifestUrl}?t=${Date.now()}`, 10000);
    remoteManifest = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    const info = {
      state: 'offline',
      currentVersion,
      message: `Sem atualização disponível agora (${err.message}).`
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  if (!remoteManifest || typeof remoteManifest !== 'object' || !remoteManifest.version || !remoteManifest.files) {
    const info = { state: 'error', currentVersion, message: 'Manifesto remoto inválido.' };
    onStatus(info);
    return { updated: false, ...info };
  }

  const remoteVersion = String(remoteManifest.version).trim();
  const isNewer = compareSemver(remoteVersion, currentVersion) > 0;

  // Verifica quais arquivos mudaram comparando SHA-256
  const entries = Object.entries(remoteManifest.files);
  const filesToDownload = [];

  for (const [relPath, meta] of entries) {
    if (!isSafeRelativePath(appDir, relPath)) continue;
    const expectedHash = typeof meta === 'string' ? meta : meta?.sha256;
    if (!expectedHash) continue;

    // Preserva o auth-config.json local se já existir, exceto se explicitamente forçado no manifesto
    if (relPath === 'auth-config.json' && fs.existsSync(path.join(appDir, relPath)) && !meta?.forceOverwrite) {
      continue;
    }

    const localHash = sha256File(path.join(appDir, relPath));
    if (localHash !== expectedHash) {
      filesToDownload.push({ relPath, expectedHash });
    }
  }

  if (!isNewer && !force && filesToDownload.length === 0) {
    const info = {
      state: 'up-to-date',
      currentVersion,
      remoteVersion,
      message: `Aplicativo atualizado (v${currentVersion}).`
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  // Em builds cliente empacotadas em app.asar (protegidas), avisa sobre nova versão sem tentar sobrescrever o .asar montado
  if (appDir.toLowerCase().includes('.asar')) {
    const info = isNewer
      ? { state: 'up-to-date', currentVersion, remoteVersion, message: `Nova versão v${remoteVersion} disponível! Baixe o instalador atualizado no Discord.` }
      : { state: 'up-to-date', currentVersion, remoteVersion, message: `Aplicativo protegido e atualizado (v${currentVersion}).` };
    onStatus(info);
    return { updated: false, ...info };
  }

  if (filesToDownload.length === 0) {
    const info = {
      state: 'up-to-date',
      currentVersion,
      remoteVersion,
      message: `Aplicativo atualizado (v${currentVersion}).`
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  // Baixa todos os arquivos alterados primeiro em memória + valida SHA-256 antes de gravar!
  const downloaded = [];
  for (let i = 0; i < filesToDownload.length; i++) {
    const item = filesToDownload[i];
    const progress = Math.round(((i) / filesToDownload.length) * 100);
    onStatus({
      state: 'downloading',
      currentVersion,
      remoteVersion,
      progress,
      message: `Baixando atualização v${remoteVersion} (${i + 1}/${filesToDownload.length})...`
    });

    const encodedPath = item.relPath.split('/').map(encodeURIComponent).join('/');
    const fileUrl = `${urls.baseUrl}${encodedPath}?v=${encodeURIComponent(remoteVersion)}`;
    const buf = await fetchBuffer(fileUrl, 20000);
    const actualHash = sha256Buffer(buf);

    if (actualHash !== item.expectedHash) {
      const info = {
        state: 'error',
        currentVersion,
        remoteVersion,
        message: `Falha de integridade (SHA-256) ao baixar ${item.relPath}. Atualização cancelada.`
      };
      onStatus(info);
      return { updated: false, ...info };
    }
    downloaded.push({ relPath: item.relPath, buffer: buf });
  }

  // Aplica gravação atômica (package.json por último para garantir consistência)
  onStatus({
    state: 'installing',
    currentVersion,
    remoteVersion,
    progress: 98,
    message: `Instalando atualização v${remoteVersion}...`
  });

  downloaded.sort((a, b) => (a.relPath === 'package.json' ? 1 : (b.relPath === 'package.json' ? -1 : 0)));
  for (const item of downloaded) {
    writeFileAtomic(path.join(appDir, item.relPath), item.buffer);
  }

  // Salva cópia local do manifesto atualizado
  writeFileAtomic(path.join(appDir, 'manifest.json'), Buffer.from(JSON.stringify(remoteManifest, null, 2), 'utf8'));

  const doneInfo = {
    state: 'updated',
    currentVersion: remoteVersion,
    remoteVersion,
    progress: 100,
    updatedFiles: downloaded.map(d => d.relPath),
    message: `Atualizado para v${remoteVersion}! Reiniciando aplicativo...`
  };
  onStatus(doneInfo);
  return { updated: true, ...doneInfo };
}

module.exports = {
  getUpdateConfig,
  getLocalVersion,
  compareSemver,
  sha256File,
  checkAndApplyUpdates
};
