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

function fetchBuffer(rawUrl, timeoutMs = 15000, redirectDepth = 0) {
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
          'User-Agent': 'PrecisionFixV4-AutoUpdater/2.0',
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

function downloadFileWithProgress(rawUrl, destPath, onProgress = () => {}, timeoutMs = 90000, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 5) return reject(new Error('Muitos redirecionamentos.'));
    let parsed;
    try {
      parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error('Protocolo inválido.'));
      }
    } catch (err) {
      return reject(new Error('URL inválida.'));
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(
      parsed,
      {
        headers: {
          'User-Agent': 'PrecisionFixV4-AutoUpdater/2.0',
          'Cache-Control': 'no-cache'
        },
        timeout: timeoutMs
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          return resolve(downloadFileWithProgress(nextUrl, destPath, onProgress, timeoutMs, redirectDepth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        const hash = crypto.createHash('sha256');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const outStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          if (totalBytes > 0) {
            onProgress(Math.min(99, Math.round((received / totalBytes) * 100)), received, totalBytes);
          }
        });

        res.pipe(outStream);

        outStream.on('finish', () => {
          outStream.close(() => {
            resolve({ sha256: hash.digest('hex'), bytes: received });
          });
        });

        outStream.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch (e) {}
          reject(err);
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Tempo esgotado no download da atualização.')));
    req.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch (e) {}
      reject(err);
    });
  });
}

function writeFileAtomic(targetPath, buffer) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.update.tmp`;
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, targetPath);
}

// Localiza o caminho real de resources/app.asar no disco (usando original-fs quando dentro do Electron)
function resolvePhysicalAsarPath(appDir) {
  const norm = path.resolve(appDir);
  const idx = norm.toLowerCase().indexOf('app.asar');
  if (idx === -1) return null;
  return norm.slice(0, idx + 'app.asar'.length);
}

function getRawFs() {
  try {
    return require('original-fs');
  } catch (e) {
    return fs;
  }
}

async function updateEncryptedAsar({ appDir, remoteManifest, currentVersion, remoteVersion, urls, onStatus, force }) {
  const asarMeta = remoteManifest.asar;
  if (!asarMeta || !asarMeta.sha256 || !asarMeta.path) {
    const info = {
      state: 'up-to-date',
      currentVersion,
      remoteVersion,
      message: `Aplicativo atualizado (v${currentVersion}).`
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  const currentAsarPath = resolvePhysicalAsarPath(appDir);
  if (!currentAsarPath) {
    const info = { state: 'error', currentVersion, message: 'Caminho do pacote app.asar não encontrado.' };
    onStatus(info);
    return { updated: false, ...info };
  }

  const rawFs = getRawFs();
  let localAsarHash = null;
  try {
    localAsarHash = sha256Buffer(rawFs.readFileSync(currentAsarPath));
  } catch (e) {}

  const isNewer = compareSemver(remoteVersion, currentVersion) > 0;
  if ((!isNewer && !force) || localAsarHash === asarMeta.sha256) {
    const info = {
      state: 'up-to-date',
      currentVersion,
      remoteVersion,
      message: `PrecisionFix v4 atualizado (v${currentVersion}).`
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  const resourcesDir = path.dirname(currentAsarPath);
  const newAsarPath = path.join(resourcesDir, 'app.asar.new');
  try { if (rawFs.existsSync(newAsarPath)) rawFs.unlinkSync(newAsarPath); } catch (e) {}

  const encodedRel = String(asarMeta.path).split('/').map(encodeURIComponent).join('/');
  const downloadUrl = asarMeta.url
    ? String(asarMeta.url)
    : `${urls.baseUrl}${encodedRel}?v=${encodeURIComponent(remoteVersion)}`;

  onStatus({
    state: 'downloading',
    currentVersion,
    remoteVersion,
    progress: 5,
    message: `Baixando atualização v${remoteVersion}... 0%`
  });

  // Usa rawFs para gravar app.asar.new diretamente na pasta resources/ sem interceptação ASAR do Electron!
  const dlResult = await new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (urlStr) => {
      if (redirects > 5) return reject(new Error('Muitos redirecionamentos.'));
      let parsed;
      try {
        parsed = new URL(urlStr);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(new Error('Protocolo inválido.'));
      } catch (e) { return reject(new Error('URL inválida.')); }

      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(
        parsed,
        { headers: { 'User-Agent': 'PrecisionFixV4-AutoUpdater/2.0', 'Cache-Control': 'no-cache' }, timeout: 120000 },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            redirects++;
            return go(new URL(res.headers.location, parsed).toString());
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || Number(asarMeta.size) || 0;
          let received = 0;
          let lastPct = -1;
          const hash = crypto.createHash('sha256');
          const outStream = rawFs.createWriteStream(newAsarPath);

          res.on('data', (chunk) => {
            received += chunk.length;
            hash.update(chunk);
            if (totalBytes > 0) {
              const pct = Math.min(98, Math.round((received / totalBytes) * 100));
              if (pct !== lastPct) {
                lastPct = pct;
                onStatus({
                  state: 'downloading',
                  currentVersion,
                  remoteVersion,
                  progress: pct,
                  message: `Baixando atualização v${remoteVersion}... ${pct}%`
                });
              }
            }
          });

          res.pipe(outStream);
          outStream.on('finish', () => outStream.close(() => resolve({ sha256: hash.digest('hex'), bytes: received })));
          outStream.on('error', (err) => {
            try { rawFs.unlinkSync(newAsarPath); } catch (e) {}
            reject(err);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Tempo esgotado no download.')));
      req.on('error', (err) => {
        try { rawFs.unlinkSync(newAsarPath); } catch (e) {}
        reject(err);
      });
    };
    go(downloadUrl);
  });

  if (dlResult.sha256 !== asarMeta.sha256) {
    try { rawFs.unlinkSync(newAsarPath); } catch (e) {}
    const info = {
      state: 'error',
      currentVersion,
      remoteVersion,
      message: 'Falha de integridade (SHA-256) no pacote de atualização. Cancelado.'
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  const doneInfo = {
    state: 'updated',
    currentVersion: remoteVersion,
    remoteVersion,
    progress: 100,
    updatedFiles: ['resources/app.asar'],
    asarSwap: {
      resourcesDir,
      currentAsarPath,
      newAsarPath
    },
    message: `Atualização v${remoteVersion} pronta! Reiniciando PrecisionFix v4...`
  };
  onStatus(doneInfo);
  return { updated: true, ...doneInfo };
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

  if (!remoteManifest || typeof remoteManifest !== 'object' || !remoteManifest.version) {
    const info = { state: 'error', currentVersion, message: 'Manifesto remoto inválido.' };
    onStatus(info);
    return { updated: false, ...info };
  }

  const remoteVersion = String(remoteManifest.version).trim();

  // MODO CLIENTE PROTEGIDO (app.asar): baixa novo app.asar criptografado, valida SHA-256 e troca automaticamente!
  if (appDir.toLowerCase().includes('.asar')) {
    return updateEncryptedAsar({ appDir, remoteManifest, currentVersion, remoteVersion, urls, onStatus, force });
  }

  // MODO PASTA SOLTA (desenvolvimento): atualiza apenas os arquivos alterados
  if (!remoteManifest.files) {
    const info = { state: 'error', currentVersion, message: 'Lista de arquivos ausente no manifesto.' };
    onStatus(info);
    return { updated: false, ...info };
  }

  const isNewer = compareSemver(remoteVersion, currentVersion) > 0;
  if (!isNewer && !force) {
    const info = {
      state: 'up-to-date',
      currentVersion,
      remoteVersion,
      message: `PrecisionFix v4 atualizado (v${currentVersion}).`
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  const entries = Object.entries(remoteManifest.files);
  const filesToDownload = [];

  for (const [relPath, meta] of entries) {
    if (!isSafeRelativePath(appDir, relPath)) continue;
    if (relPath.startsWith('releases/')) continue;
    const expectedHash = typeof meta === 'string' ? meta : meta?.sha256;
    if (!expectedHash) continue;

    if (relPath === 'auth-config.json' && fs.existsSync(path.join(appDir, relPath)) && !meta?.forceOverwrite) {
      continue;
    }

    const localHash = sha256File(path.join(appDir, relPath));
    if (localHash !== expectedHash) {
      filesToDownload.push({ relPath, expectedHash });
    }
  }

  if (filesToDownload.length === 0) {
    const info = {
      state: 'up-to-date',
      currentVersion,
      remoteVersion,
      message: `PrecisionFix v4 atualizado (v${currentVersion}).`
    };
    onStatus(info);
    return { updated: false, ...info };
  }

  const downloaded = [];
  for (let i = 0; i < filesToDownload.length; i++) {
    const item = filesToDownload[i];
    const progress = Math.round((i / filesToDownload.length) * 100);
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

  writeFileAtomic(path.join(appDir, 'manifest.json'), Buffer.from(JSON.stringify(remoteManifest, null, 2), 'utf8'));

  const doneInfo = {
    state: 'updated',
    currentVersion: remoteVersion,
    remoteVersion,
    progress: 100,
    updatedFiles: downloaded.map(d => d.relPath),
    message: `Atualizado para v${remoteVersion}! Reiniciando PrecisionFix v4...`
  };
  onStatus(doneInfo);
  return { updated: true, ...doneInfo };
}

module.exports = {
  getUpdateConfig,
  getLocalVersion,
  compareSemver,
  sha256File,
  downloadFileWithProgress,
  checkAndApplyUpdates
};
