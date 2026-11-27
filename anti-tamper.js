const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const https = require('https');

let tamperTriggered = false;
let watchdogTimer = null;

function isProtectedBuild(appDir) {
  return fs.existsSync(path.join(appDir, 'integrity.sig'));
}

function getClientHWIDFallback() {
  const cpuModel = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) ? os.cpus()[0].model : 'UNKNOWN-CPU';
  const machineId = os.hostname() + os.totalmem() + cpuModel;
  return crypto.createHash('sha256').update(machineId).digest('hex');
}

function readAuthApiUrl(appDir) {
  let url = 'http://127.0.0.1:3001';
  try {
    const cfgPath = path.join(appDir, 'auth-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && parsed.authApiUrl) url = String(parsed.authApiUrl).trim();
    }
  } catch (e) {}
  if (process.env.FORGOATS_AUTH_URL && process.env.FORGOATS_AUTH_URL.trim()) {
    url = process.env.FORGOATS_AUTH_URL.trim();
  }
  return url.replace(/\/+$/, '');
}

function sendTamperRevokeRequest(appDir, payload) {
  const baseUrl = readAuthApiUrl(appDir);
  return new Promise((resolve) => {
    try {
      const targetUrl = new URL('/api/auth/tamper', `${baseUrl}/`);
      const body = JSON.stringify(payload);
      const transport = targetUrl.protocol === 'https:' ? https : http;
      const req = transport.request(
        targetUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 5000
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(true));
        }
      );
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.write(body);
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

function detectDebugEnvironment(appDir) {
  const forbiddenArgs = ['--inspect', '--inspect-brk', '--inspect-port', '--remote-debugging-port', '--js-flags'];
  for (const arg of process.argv || []) {
    const low = String(arg).toLowerCase();
    if (forbiddenArgs.some(flag => low === flag || low.startsWith(flag + '='))) {
      return `flag_depuracao:${low}`;
    }
  }

  if (process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_OPTIONS || process.env.NODE_INSPECT_RESUME_ON_START) {
    return 'variavel_ambiente_intrusao';
  }

  // Se estiver rodando empacotado (app.asar), rejeita injeção de pasta solta resources/app
  if (appDir.toLowerCase().includes('app.asar')) {
    const resourcesDir = path.dirname(appDir);
    const looseAppDir = path.join(resourcesDir, 'app');
    if (fs.existsSync(looseAppDir)) {
      return 'pasta_app_injetada';
    }
  }

  return null;
}

function verifyIntegritySeal(appDir, hmacSecret) {
  const sigPath = path.join(appDir, 'integrity.sig');
  if (!fs.existsSync(sigPath)) return { ok: true, armed: false };

  let sigData;
  try {
    sigData = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
  } catch (e) {
    return { ok: false, armed: true, reason: 'assinatura_corrompida' };
  }

  if (!sigData || !sigData.files || typeof sigData.hmac !== 'string') {
    return { ok: false, armed: true, reason: 'assinatura_invalida' };
  }

  // Valida HMAC da lista de hashes usando a chave secreta da build
  if (hmacSecret) {
    const canonical = JSON.stringify({ version: sigData.version, files: sigData.files });
    const expectedHmac = crypto.createHmac('sha256', hmacSecret).update(canonical).digest('hex');
    const a = Buffer.from(sigData.hmac, 'hex');
    const b = Buffer.from(expectedHmac, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, armed: true, reason: 'hmac_adulterado' };
    }
  }

  for (const [relPath, expectedHash] of Object.entries(sigData.files)) {
    const full = path.join(appDir, relPath);
    if (!fs.existsSync(full)) {
      return { ok: false, armed: true, reason: `arquivo_removido:${relPath}` };
    }
    try {
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (actualHash !== expectedHash) {
        return { ok: false, armed: true, reason: `arquivo_modificado:${relPath}` };
      }
    } catch (e) {
      return { ok: false, armed: true, reason: `erro_leitura:${relPath}` };
    }
  }

  return { ok: true, armed: true };
}

async function handleTamperViolation({ app, dialog, appDir, reason, getUsername, getHwid }) {
  if (tamperTriggered) return;
  tamperTriggered = true;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  let username = '';
  try { username = (typeof getUsername === 'function' ? getUsername() : '') || ''; } catch (e) {}

  // Se ainda não fez login nesta sessão, tenta recuperar usuário do autologin local
  if (!username && app) {
    try {
      const autoPath = path.join(app.getPath('userData'), 'autologin.json');
      if (fs.existsSync(autoPath)) {
        const autoData = JSON.parse(fs.readFileSync(autoPath, 'utf8'));
        if (autoData && autoData.username) username = String(autoData.username);
      }
    } catch (e) {}
  }

  const hwid = (typeof getHwid === 'function' ? getHwid() : '') || getClientHWIDFallback();

  // 1. Revoga e auto-exclui o token no Bot For Goats
  await sendTamperRevokeRequest(appDir, {
    username: String(username || ''),
    hwid: String(hwid),
    reason: String(reason || 'modificacao_detectada'),
    machine: String(os.hostname() || '')
  });

  // 2. Remove dados de sessão locais imediatamente
  if (app) {
    try {
      const userData = app.getPath('userData');
      ['autologin.json', 'users_db.json'].forEach((file) => {
        const p = path.join(userData, file);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
    } catch (e) {}
  }

  // 3. Alerta o usuário e encerra imediatamente
  try {
    if (dialog) {
      dialog.showErrorBox(
        'Proteção Anti-Fraude • Community For Goats',
        `Tentativa de modificação ou intrusão detectada (${reason}).\n\nPor segurança, seu token de acesso foi revogado automaticamente e a sessão foi encerrada.`
      );
    }
  } catch (e) {}

  if (app) app.exit(1);
  else process.exit(1);
}

function hardenWindow(win, { app, dialog, appDir, getUsername, getHwid }) {
  if (!isProtectedBuild(appDir) || !win || win.isDestroyed()) return;

  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toUpperCase();
    const ctrlShift = (input.control || input.meta) && input.shift;
    if (
      key === 'F12' ||
      (ctrlShift && ['I', 'J', 'C', 'K'].includes(key)) ||
      ((input.control || input.meta) && key === 'U')
    ) {
      event.preventDefault();
    }
  });

  win.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });

  win.webContents.on('devtools-opened', () => {
    try { win.webContents.closeDevTools(); } catch (e) {}
    void handleTamperViolation({ app, dialog, appDir, reason: 'devtools_aberto', getUsername, getHwid });
  });
}

function startAntiTamperWatchdog({ app, dialog, appDir, hmacSecret, getUsername, getHwid }) {
  if (!isProtectedBuild(appDir)) return;

  const checkNow = () => {
    const envReason = detectDebugEnvironment(appDir);
    if (envReason) {
      void handleTamperViolation({ app, dialog, appDir, reason: envReason, getUsername, getHwid });
      return false;
    }
    const seal = verifyIntegritySeal(appDir, hmacSecret);
    if (!seal.ok) {
      void handleTamperViolation({ app, dialog, appDir, reason: seal.reason, getUsername, getHwid });
      return false;
    }
    return true;
  };

  if (!checkNow()) return;

  watchdogTimer = setInterval(checkNow, 20000);
}

module.exports = {
  isProtectedBuild,
  detectDebugEnvironment,
  verifyIntegritySeal,
  handleTamperViolation,
  hardenWindow,
  startAntiTamperWatchdog
};
