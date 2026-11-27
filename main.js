const { app, BrowserWindow, ipcMain, Tray, Menu, session } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { uIOhook } = require('uiohook-napi');

let mainWindow = null;
let loginWindow = null;
let tray = null;
let currentMouseBind = null;
let activeSession = null;
let sessionMonitorTimer = null;

// --- CONFIGURAÇÃO DA API DE AUTENTICAÇÃO (BOT FOR GOATS) ---
function getAuthConfig() {
  const defaults = {
    authApiUrl: 'http://127.0.0.1:3001',
    verifyIntervalMs: 30000,
    requestTimeoutMs: 8000
  };

  try {
    const configPath = path.join(__dirname, 'auth-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        Object.assign(defaults, parsed);
      }
    }
  } catch (e) {}

  if (process.env.FORGOATS_AUTH_URL && process.env.FORGOATS_AUTH_URL.trim()) {
    defaults.authApiUrl = process.env.FORGOATS_AUTH_URL.trim();
  }

  defaults.authApiUrl = String(defaults.authApiUrl).replace(/\/+$/, '');
  return defaults;
}

// --- CLIENTE HTTP/HTTPS PARA A API DO BOT DO DISCORD ---
function postAuthApi(endpoint, payload) {
  const { authApiUrl, requestTimeoutMs } = getAuthConfig();

  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(endpoint, `${authApiUrl}/`);
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return reject(new Error('URL da API de autenticação inválida.'));
      }
    } catch (err) {
      return reject(new Error('URL da API de autenticação mal configurada em auth-config.json.'));
    }

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
        timeout: requestTimeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (e) {
            data = { success: false, message: 'Resposta inválida do servidor de autenticação.' };
          }
          resolve({ status: res.statusCode || 0, data });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('TIMEOUT'));
    });

    req.on('error', (err) => {
      if (err.message === 'TIMEOUT') {
        reject(new Error('Tempo esgotado ao conectar ao servidor do Bot For Goats.'));
      } else {
        reject(new Error('Não foi possível conectar ao Bot For Goats. Verifique se o bot está ligado.'));
      }
    });

    req.write(body);
    req.end();
  });
}

// --- FUNÇÃO PARA GERAR O HWID ÚNICO DA MÁQUINA (ANTI-BULAR) ---
function getClientHWID() {
  const os = require('os');
  const cpuModel = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) ? os.cpus()[0].model : 'UNKNOWN-CPU';
  const machineId = os.hostname() + os.totalmem() + cpuModel;
  return crypto.createHash('sha256').update(machineId).digest('hex');
}

function getAutoLoginPath() {
  return path.join(app.getPath('userData'), 'autologin.json');
}

function clearAutoLogin() {
  try {
    const autoLoginPath = getAutoLoginPath();
    if (fs.existsSync(autoLoginPath)) fs.unlinkSync(autoLoginPath);
  } catch (e) {}
}

// --- MONITORAMENTO CONTÍNUO DE TOKEN (EXPIRAÇÃO / RESET / EXCLUSÃO) ---
function stopSessionMonitor() {
  if (sessionMonitorTimer) {
    clearInterval(sessionMonitorTimer);
    sessionMonitorTimer = null;
  }
}

function forceLogoutToLogin(reasonMessage) {
  stopSessionMonitor();
  activeSession = null;
  clearAutoLogin();

  if (mainWindow) {
    const win = mainWindow;
    mainWindow = null;
    try { win.close(); } catch (e) {}
  }

  createLoginWindow(reasonMessage);
}

function startSessionMonitor() {
  stopSessionMonitor();
  const { verifyIntervalMs } = getAuthConfig();
  const interval = Math.max(10000, Number(verifyIntervalMs) || 30000);

  sessionMonitorTimer = setInterval(async () => {
    if (!activeSession || !mainWindow) return;
    try {
      const { data } = await postAuthApi('/api/auth/verify', {
        username: activeSession.username,
        hwid: activeSession.hwid
      });
      if (data && data.valid === false) {
        forceLogoutToLogin(data.message || 'Sessão encerrada. Faça login novamente.');
      }
    } catch (e) {
      // Se houver oscilação temporária de rede, tenta novamente no próximo ciclo.
    }
  }, interval);
}

// --- CRIAR JANELA DE LOGIN ---
function createLoginWindow(initialErrorMessage = null) {
  if (loginWindow) {
    loginWindow.focus();
    if (initialErrorMessage) {
      loginWindow.webContents.send('resposta-auth', { success: false, message: initialErrorMessage });
    }
    return;
  }

  loginWindow = new BrowserWindow({
    width: 420,
    height: 520,
    frame: true,
    resizable: false,
    center: true,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  loginWindow.loadFile(path.join(__dirname, 'login.html'));
  loginWindow.setMenu(null);
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  if (initialErrorMessage) {
    loginWindow.webContents.once('did-finish-load', () => {
      if (loginWindow) {
        loginWindow.webContents.send('resposta-auth', { success: false, message: initialErrorMessage });
      }
    });
  }

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// --- CRIAR JANELA PRINCIPAL DO APLICATIVO ---
function createWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    center: true,
    backgroundColor: '#0b0b0b',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopSessionMonitor();
  });

  startSessionMonitor();
}

// --- FUNÇÃO PARA VERIFICAR AUTO-LOGIN NO ARRANQUE (VIA API DO BOT) ---
async function checkAutoLogin() {
  const hwid = getClientHWID();
  const autoLoginPath = getAutoLoginPath();

  try {
    if (!fs.existsSync(autoLoginPath)) return false;
    const autoData = JSON.parse(fs.readFileSync(autoLoginPath, 'utf8'));
    if (!autoData || !autoData.username || autoData.hwid !== hwid) {
      clearAutoLogin();
      return false;
    }

    const { status, data } = await postAuthApi('/api/auth/verify', {
      username: String(autoData.username).trim(),
      hwid
    });

    if (status === 200 && data && data.valid === true) {
      activeSession = {
        username: String(autoData.username).trim(),
        hwid,
        expiresAt: data.expiresAt || null
      };
      return true;
    }

    if (data && data.valid === false) {
      clearAutoLogin();
    }
  } catch (e) {}
  return false;
}

// --- ATUALIZAÇÃO DO MENU DO SYSTEM TRAY (COM ATALHOS RÁPIDOS) ---
function setupTray() {
  if (!tray) {
    const iconPath = fs.existsSync(path.join(__dirname, 'ico.png'))
      ? path.join(__dirname, 'ico.png')
      : path.join(__dirname, 'perfil.jpg');

    try {
      tray = new Tray(iconPath);
      tray.setToolTip('Community For Goats • Precision Fix');

      const contextMenu = Menu.buildFromTemplate([
        { label: 'Abrir Painel Principal', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        {
          label: 'Limpar Cache FiveM',
          click: () => {
            const dataPath = path.join(process.env.LOCALAPPDATA, 'FiveM', 'FiveM.app', 'data');
            ['cache', 'server-cache', 'server-cache-priv'].forEach(folder => {
              const folderPath = path.join(dataPath, folder);
              try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch (err) {}
            });
          }
        },
        { label: 'Limpar DNS (Flush DNS)', click: () => { exec('ipconfig /flushdns'); } },
        { type: 'separator' },
        {
          label: 'Terminar Sessão (Logout)',
          click: () => {
            stopSessionMonitor();
            activeSession = null;
            clearAutoLogin();
            app.relaunch();
            app.exit();
          }
        },
        { label: 'Sair', click: () => { app.isQuiting = true; app.quit(); } }
      ]);

      tray.setContextMenu(contextMenu);
      tray.on('click', () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      });
    } catch (e) {}
  }
}

// --- GESTOR DE AUTENTICAÇÃO INTEGRADO AO BOT FOR GOATS ---
ipcMain.on('processar-auth', async (event, data) => {
  const hwid = getClientHWID();
  const username = String(data?.username || '').trim();
  const password = String(data?.password || '');
  const token = String(data?.token || '').trim();
  const rememberMe = Boolean(data?.rememberMe);

  if (data?.action === 'register') {
    if (!username || !password || !token) {
      event.sender.send('resposta-auth', { success: false, message: 'Preencha todos os campos.' });
      return;
    }

    try {
      const { status, data: resData } = await postAuthApi('/api/auth/register', {
        username,
        password,
        token,
        hwid
      });

      if (status === 200 && resData && resData.success) {
        activeSession = { username, hwid, expiresAt: resData.expiresAt || null };
        event.sender.send('resposta-auth', {
          success: true,
          message: resData.message || 'Conta criada e token vinculado!'
        });
        setTimeout(() => {
          createWindow();
          setupTray();
          if (loginWindow) loginWindow.close();
        }, 900);
      } else {
        event.sender.send('resposta-auth', {
          success: false,
          message: (resData && resData.message) || 'Não foi possível criar a conta.'
        });
      }
    } catch (err) {
      event.sender.send('resposta-auth', { success: false, message: err.message });
    }
    return;
  }

  if (data?.action === 'login') {
    if (!username || !password) {
      event.sender.send('resposta-auth', { success: false, message: 'Preencha o utilizador e a palavra-passe.' });
      return;
    }

    try {
      const { status, data: resData } = await postAuthApi('/api/auth/login', {
        username,
        password,
        hwid
      });

      if (status === 200 && resData && resData.success) {
        activeSession = { username, hwid, expiresAt: resData.expiresAt || null };

        if (rememberMe) {
          fs.writeFileSync(getAutoLoginPath(), JSON.stringify({ username, hwid }, null, 2));
        } else {
          clearAutoLogin();
        }

        event.sender.send('resposta-auth', {
          success: true,
          message: resData.message || 'Autenticado! A abrir painel...'
        });
        setTimeout(() => {
          createWindow();
          setupTray();
          if (loginWindow) loginWindow.close();
        }, 800);
      } else {
        event.sender.send('resposta-auth', {
          success: false,
          message: (resData && resData.message) || 'Falha na autenticação.'
        });
      }
    } catch (err) {
      event.sender.send('resposta-auth', { success: false, message: err.message });
    }
  }
});

// --- INICIALIZAÇÃO INTELIGENTE ---
app.whenReady().then(async () => {
  // Bloqueio estrito de requisições externas no renderer (HTTP/HTTPS/WS/WSS/FTP)
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (details, callback) => {
      callback({ cancel: true });
    }
  );

  if (await checkAutoLogin()) {
    createWindow();
    setupTray();
  } else {
    createLoginWindow();
  }

  try {
    uIOhook.on('mousedown', (event) => {
      if (currentMouseBind !== null && event.button === currentMouseBind) {
        if (mainWindow) {
          mainWindow.webContents.send('trigger-mira-bind');
        }
      }
    });
    uIOhook.start();
  } catch (e) {}
});

app.on('before-quit', () => {
  stopSessionMonitor();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
