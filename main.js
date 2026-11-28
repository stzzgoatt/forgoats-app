const { app, BrowserWindow, ipcMain, Tray, Menu, session, screen, globalShortcut, dialog } = require('electron');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { uIOhook } = require('uiohook-napi');
const keyboardTweaks = require('./keyboard-tweaks');
const updater = require('./updater');
const antiTamper = require('./anti-tamper');

let saturationModule = null;
try {
  saturationModule = require('./saturation');
} catch (e) {}

let user32SpiSpeed = null;
let user32SpiMouse = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  user32SpiSpeed = user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, uintptr_t pvParam, uint32 fWinIni)');
  user32SpiMouse = user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, int32 *pvParam, uint32 fWinIni)');
} catch (e) {}

let mainWindow = null;
let loginWindow = null;
let crosshairWindow = null;
let tray = null;
let currentMouseBind = null;
let currentKeyBind = null;
let lastCrosshairConfig = null;
let minToTrayEnabled = false;
let activeSession = null;
let sessionMonitorTimer = null;
let updateCheckTimer = null;
let updateInProgress = false;
let lastUpdateStatus = {
  state: 'idle',
  currentVersion: updater.getLocalVersion(__dirname),
  message: `Versão atual: v${updater.getLocalVersion(__dirname)}`
};

function broadcastUpdateStatus(statusObj) {
  lastUpdateStatus = { ...lastUpdateStatus, ...statusObj };
  [mainWindow, loginWindow].forEach((win) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('update-status', lastUpdateStatus); } catch (e) {}
    }
  });
}

function launchAsarSwapperAndExit(asarSwap) {
  const os = require('os');
  const scriptPath = path.join(os.tmpdir(), `pfv4_swap_${Date.now()}.cmd`);
  const exePath = process.execPath;
  const pid = process.pid;
  const cmdContent = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    `set "TARGET_PID=${pid}"`,
    `set "CUR_ASAR=${asarSwap.currentAsarPath}"`,
    `set "NEW_ASAR=${asarSwap.newAsarPath}"`,
    `set "APP_EXE=${exePath}"`,
    'set /a WAIT_TRIES=0',
    ':waitloop',
    'set /a WAIT_TRIES+=1',
    'if !WAIT_TRIES! GTR 20 goto swaploop',
    'tasklist /FI "PID eq %TARGET_PID%" /NH 2>NUL | findstr /R /C:" %TARGET_PID% " >NUL',
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >NUL',
    '  goto waitloop',
    ')',
    'set /a SWAP_TRIES=0',
    ':swaploop',
    'set /a SWAP_TRIES+=1',
    'move /Y "%NEW_ASAR%" "%CUR_ASAR%" >NUL 2>&1',
    'if errorlevel 1 (',
    '  if !SWAP_TRIES! LSS 12 (',
    '    timeout /t 1 /nobreak >NUL',
    '    goto swaploop',
    '  )',
    ')',
    'start "" "%APP_EXE%"',
    'del /F /Q "%~f0" >NUL 2>&1'
  ].join('\r\n');

  fs.writeFileSync(scriptPath, cmdContent, 'utf8');
  const child = spawn('cmd.exe', ['/c', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  app.isQuiting = true;
  app.exit(0);
}

async function runAutoUpdateCheck(force = false) {
  if (updateInProgress) return;
  updateInProgress = true;
  try {
    const config = updater.getUpdateConfig(__dirname);
    const result = await updater.checkAndApplyUpdates({
      appDir: __dirname,
      force,
      onStatus: (info) => broadcastUpdateStatus(info)
    });
    if (result && result.updated && config.autoRestart !== false) {
      setTimeout(() => {
        if (result.asarSwap) {
          launchAsarSwapperAndExit(result.asarSwap);
        } else {
          app.isQuiting = true;
          app.relaunch();
          app.exit(0);
        }
      }, 1500);
    }
  } catch (err) {
    broadcastUpdateStatus({ state: 'error', message: `Erro ao atualizar: ${err.message}` });
  } finally {
    updateInProgress = false;
  }
}

// --- TEMA GLOBAL PADRÃO (FULL PRETO + CIANO CLARO + TEXTO BRANCO) ---
const DEFAULT_THEME = {
  preset: 'full-black-ciano',
  accent: '#00e5ff',
  bg: '#000000',
  text: '#ffffff'
};

function sanitizeHexColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : fallback;
}

function getThemePath() {
  return path.join(app.getPath('userData'), 'theme.json');
}

function loadTheme() {
  try {
    const themePath = getThemePath();
    if (fs.existsSync(themePath)) {
      const parsed = JSON.parse(fs.readFileSync(themePath, 'utf8'));
      return {
        preset: typeof parsed.preset === 'string' ? parsed.preset : 'custom',
        accent: sanitizeHexColor(parsed.accent, DEFAULT_THEME.accent),
        bg: sanitizeHexColor(parsed.bg, DEFAULT_THEME.bg),
        text: sanitizeHexColor(parsed.text, DEFAULT_THEME.text)
      };
    }
  } catch (e) {}
  return { ...DEFAULT_THEME };
}

function saveTheme(rawTheme) {
  const clean = {
    preset: typeof rawTheme?.preset === 'string' ? rawTheme.preset : 'custom',
    accent: sanitizeHexColor(rawTheme?.accent, DEFAULT_THEME.accent),
    bg: sanitizeHexColor(rawTheme?.bg, DEFAULT_THEME.bg),
    text: sanitizeHexColor(rawTheme?.text, DEFAULT_THEME.text)
  };
  try {
    fs.writeFileSync(getThemePath(), JSON.stringify(clean, null, 2));
  } catch (e) {}

  // Atualiza a cor nativa de fundo das janelas abertas e sincroniza com todas as telas
  [mainWindow, loginWindow].forEach((win) => {
    if (win && !win.isDestroyed()) {
      try { win.setBackgroundColor(clean.bg); } catch (e) {}
      try { win.webContents.send('theme-updated', clean); } catch (e) {}
    }
  });
  return clean;
}

// --- CONFIGURAÇÃO DA API DE AUTENTICAÇÃO (BOT FOR GOATS) ---
function getAuthConfig() {
  const defaults = {
    authApiUrl: 'http://127.0.0.1:3001',
    verifyIntervalMs: 20000,
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

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(stdout);
    });
  });
}

// --- MONITORAMENTO CONTÍNUO DE TOKEN (EXPIRAÇÃO / RESET / EXCLUSÃO) ---
function stopSessionMonitor() {
  if (sessionMonitorTimer) {
    clearInterval(sessionMonitorTimer);
    sessionMonitorTimer = null;
  }
}

function notifySessionLogout(sessionSnapshot) {
  if (!sessionSnapshot || !sessionSnapshot.username || !sessionSnapshot.hwid) return;
  void postAuthApi('/api/auth/logout', {
    username: String(sessionSnapshot.username),
    hwid: String(sessionSnapshot.hwid)
  }).catch(() => {});
}

function forceLogoutToLogin(reasonMessage) {
  stopSessionMonitor();
  const prevSession = activeSession;
  activeSession = null;
  clearAutoLogin();
  notifySessionLogout(prevSession);

  if (crosshairWindow && !crosshairWindow.isDestroyed()) {
    try { crosshairWindow.close(); } catch (e) {}
    crosshairWindow = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    const win = mainWindow;
    mainWindow = null;
    try { win.destroy(); } catch (e) {}
  }

  createLoginWindow(reasonMessage);
}

function startSessionMonitor() {
  stopSessionMonitor();
  const { verifyIntervalMs } = getAuthConfig();
  const interval = Math.max(10000, Number(verifyIntervalMs) || 20000);

  sessionMonitorTimer = setInterval(async () => {
    if (!activeSession || !mainWindow) return;
    try {
      const { data } = await postAuthApi('/api/auth/verify', {
        username: activeSession.username,
        hwid: activeSession.hwid
      });
      if (data && data.valid === false) {
        forceLogoutToLogin(data.message || 'Sessão encerrada. Faça login novamente.');
      } else if (data && data.valid === true && data.expiresAt !== undefined) {
        const nextExpires = Number(data.expiresAt) || null;
        if (nextExpires !== activeSession.expiresAt) {
          activeSession.expiresAt = nextExpires;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('current-user', {
              username: activeSession.username,
              expiresAt: activeSession.expiresAt
            });
          }
        }
      }
    } catch (e) {}
  }, interval);
}

// --- CRIAR JANELA DE LOGIN (SEM BARRA CINZA DO WINDOWS) ---
function createLoginWindow(initialErrorMessage = null) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    if (initialErrorMessage) {
      loginWindow.webContents.send('resposta-auth', { success: false, message: initialErrorMessage });
    }
    return;
  }

  const theme = loadTheme();

  loginWindow = new BrowserWindow({
    width: 860,
    height: 540,
    frame: false,
    resizable: false,
    center: true,
    icon: path.join(__dirname, 'app.ico'),
    backgroundColor: theme.bg,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: !antiTamper.isProtectedBuild(__dirname)
    }
  });

  loginWindow.loadFile(path.join(__dirname, 'login.html'));
  loginWindow.setMenu(null);
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  antiTamper.hardenWindow(loginWindow, {
    app,
    dialog,
    appDir: __dirname,
    getUsername: () => activeSession?.username || '',
    getHwid: getClientHWID
  });

  loginWindow.webContents.once('did-finish-load', () => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.webContents.send('theme-updated', loadTheme());
      if (initialErrorMessage) {
        loginWindow.webContents.send('resposta-auth', { success: false, message: initialErrorMessage });
      }
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// --- CRIAR JANELA PRINCIPAL DO APLICATIVO (TAMANHO IDEAL + SEM BARRA CINZA) ---
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const theme = loadTheme();

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 1020,
    minHeight: 650,
    frame: false,
    resizable: true,
    center: true,
    icon: path.join(__dirname, 'app.ico'),
    backgroundColor: theme.bg,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: !antiTamper.isProtectedBuild(__dirname)
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  antiTamper.hardenWindow(mainWindow, {
    app,
    dialog,
    appDir: __dirname,
    getUsername: () => activeSession?.username || '',
    getHwid: getClientHWID
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme-updated', loadTheme());
      if (activeSession) {
        mainWindow.webContents.send('current-user', {
          username: activeSession.username,
          expiresAt: activeSession.expiresAt || null
        });
      }
    }
  });

  mainWindow.on('close', (event) => {
    if (minToTrayEnabled && !app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopSessionMonitor();
  });

  startSessionMonitor();
}

// --- JANELA OVERLAY DA MIRA (CROSSHAIR) ---
function ensureCrosshairWindow() {
  if (crosshairWindow && !crosshairWindow.isDestroyed()) return crosshairWindow;

  const { width, height, x, y } = screen.getPrimaryDisplay().bounds;
  crosshairWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: !antiTamper.isProtectedBuild(__dirname)
    }
  });

  crosshairWindow.setIgnoreMouseEvents(true, { forward: true });
  crosshairWindow.setAlwaysOnTop(true, 'screen-saver');
  crosshairWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  crosshairWindow.loadFile(path.join(__dirname, 'crosshair.html'));
  antiTamper.hardenWindow(crosshairWindow, {
    app,
    dialog,
    appDir: __dirname,
    getUsername: () => activeSession?.username || '',
    getHwid: getClientHWID
  });

  crosshairWindow.webContents.once('did-finish-load', () => {
    if (crosshairWindow && !crosshairWindow.isDestroyed()) {
      if (lastCrosshairConfig) {
        crosshairWindow.webContents.send('update-crosshair', lastCrosshairConfig);
      }
      crosshairWindow.webContents.send('set-visibility', true);
    }
  });

  crosshairWindow.on('closed', () => {
    crosshairWindow = null;
  });

  return crosshairWindow;
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
      tray.setToolTip('PrecisionFix v4 • Community For Goats');

      const contextMenu = Menu.buildFromTemplate([
        { label: 'Abrir Painel Principal', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        {
          label: 'Limpar Cache FiveM',
          click: () => {
            const dataPath = path.join(process.env.LOCALAPPDATA || '', 'FiveM', 'FiveM.app', 'data');
            ['cache', 'server-cache', 'server-cache-priv'].forEach(folder => {
              const folderPath = path.join(dataPath, folder);
              try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch (err) {}
            });
          }
        },
        { label: 'Limpar DNS (Flush DNS)', click: () => { exec('ipconfig /flushdns', { windowsHide: true }); } },
        { type: 'separator' },
        {
          label: 'Terminar Sessão (Logout)',
          click: () => {
            forceLogoutToLogin('Você saiu da sua conta. Faça login novamente.');
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

// --- IPC: CONTROLES DE JANELA (PAINEL E LOGIN) ---
ipcMain.on('window-min', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.on('window-max', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('window-close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (minToTrayEnabled) {
    mainWindow.hide();
  } else {
    app.isQuiting = true;
    app.quit();
  }
});

ipcMain.on('login-min', () => {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.minimize();
});

ipcMain.on('login-close', () => {
  app.isQuiting = true;
  app.quit();
});

// --- IPC: TEMA GLOBAL & USUÁRIO LOGADO ---
ipcMain.on('get-theme', (event) => {
  event.returnValue = loadTheme();
});

ipcMain.on('save-theme', (event, theme) => {
  saveTheme(theme);
});

ipcMain.on('get-current-user', (event) => {
  event.sender.send('current-user', activeSession
    ? { username: activeSession.username, expiresAt: activeSession.expiresAt || null }
    : { username: 'Usuário', expiresAt: null }
  );
});

ipcMain.on('logout-account', () => {
  forceLogoutToLogin('Você saiu da sua conta. Faça login novamente.');
});

ipcMain.on('get-update-status', (event) => {
  event.sender.send('update-status', lastUpdateStatus);
});

ipcMain.on('check-updates', () => {
  void runAutoUpdateCheck(true);
});

// --- IPC: CONFIGURAÇÕES DO SISTEMA ---
ipcMain.on('set-autostart', (event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  } catch (e) {}
});

ipcMain.on('set-min-tray', (event, enabled) => {
  minToTrayEnabled = Boolean(enabled);
});

// --- IPC: SATURAÇÃO DO DISPLAY ---
ipcMain.on('change-saturation', (event, factor) => {
  if (!saturationModule) return;
  const val = Number(factor);
  if (!Number.isFinite(val)) return;
  const clamped = Math.max(0, Math.min(2, val));
  try {
    saturationModule.setSaturation(clamped);
  } catch (e) {}
});

// --- IPC: SENSIBILIDADE E ACELERAÇÃO DO MOUSE (APLICADA NA HORA) ---
ipcMain.on('apply-sensi', async (event, { speed, accel } = {}) => {
  try {
    const cleanSpeed = Math.max(1, Math.min(20, parseInt(speed, 10) || 10));
    const useAccel = Boolean(accel);
    const SPI_SETMOUSESPEED = 0x0071;
    const SPI_SETMOUSE = 0x0004;
    const SPIF_UPDATEINIFILE_SENDCHANGE = 0x03;

    if (user32SpiSpeed) {
      user32SpiSpeed(SPI_SETMOUSESPEED, 0, cleanSpeed, SPIF_UPDATEINIFILE_SENDCHANGE);
    }
    if (user32SpiMouse) {
      const mouseParams = useAccel ? [6, 10, 1] : [0, 0, 0];
      user32SpiMouse(SPI_SETMOUSE, 0, mouseParams, SPIF_UPDATEINIFILE_SENDCHANGE);
    }

    await runCmd(`reg add "HKCU\\Control Panel\\Mouse" /v MouseSensitivity /t REG_SZ /d ${cleanSpeed} /f`);
    await runCmd(`reg add "HKCU\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d ${useAccel ? '1' : '0'} /f`);
    await runCmd(`reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold1 /t REG_SZ /d ${useAccel ? '6' : '0'} /f`);
    await runCmd(`reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold2 /t REG_SZ /d ${useAccel ? '10' : '0'} /f`);

    event.sender.send('apply-sensi-reply', true);
  } catch (err) {
    event.sender.send('apply-sensi-reply', false);
  }
});

// --- IPC: PRECISIONFIX (AJUSTES DE MOUSE E SISTEMA) ---
const LINEAR_CURVE_X = '0000000000000000c0cc0c0000000000809919000000000040662600000000000033330000000000';
const LINEAR_CURVE_Y = '0000000000000000000038000000000000007000000000000000a800000000000000e00000000000';
const DEFAULT_CURVE_X = '0000000000000000156e000000000000004001000000000029dc0300000000000000280000000000';
const DEFAULT_CURVE_Y = '0000000000000000fd11010000000000002404000000000000fc12000000000000c0bb0100000000';

ipcMain.on('apply-precision-tweaks', async (event, tweaks = {}) => {
  try {
    const cmds = [];

    const wantsRawMouse = Boolean(
      tweaks['mouse-precision'] ||
      tweaks['k1ng-tracking'] ||
      tweaks['k1ng-sensi'] ||
      tweaks['k1ng-flick'] ||
      tweaks['k1ng-sensi-x-y'] ||
      tweaks['k1ng-registros-mouse']
    );

    if (wantsRawMouse) {
      cmds.push('reg add "HKCU\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d 0 /f');
      cmds.push('reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold1 /t REG_SZ /d 0 /f');
      cmds.push('reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold2 /t REG_SZ /d 0 /f');
      cmds.push(`reg add "HKCU\\Control Panel\\Mouse" /v SmoothMouseXCurve /t REG_BINARY /d ${LINEAR_CURVE_X} /f`);
      cmds.push(`reg add "HKCU\\Control Panel\\Mouse" /v SmoothMouseYCurve /t REG_BINARY /d ${LINEAR_CURVE_Y} /f`);
      cmds.push('reg add "HKCU\\Control Panel\\Mouse" /v MouseHoverTime /t REG_SZ /d 10 /f');
      if (user32SpiMouse) {
        try { user32SpiMouse(0x0004, 0, [0, 0, 0], 0x03); } catch (e) {}
      }
    }

    if (tweaks['k1ng-accessibility'] || tweaks['k1ng-flags']) {
      cmds.push('reg add "HKCU\\Control Panel\\Accessibility\\MouseKeys" /v Flags /t REG_SZ /d 0 /f');
      cmds.push('reg add "HKCU\\Control Panel\\Accessibility\\StickyKeys" /v Flags /t REG_SZ /d 506 /f');
      cmds.push('reg add "HKCU\\Control Panel\\Accessibility\\Keyboard Response" /v Flags /t REG_SZ /d 122 /f');
      cmds.push('reg add "HKCU\\Control Panel\\Accessibility\\ToggleKeys" /v Flags /t REG_SZ /d 58 /f');
    }

    if (tweaks['performance-boost'] || tweaks['k1ng-boost-fivem'] || tweaks['k1ng-0.5ms'] || tweaks['k1ng-islc']) {
      cmds.push('reg add "HKCU\\Software\\Microsoft\\GameBar" /v AutoGameModeEnabled /t REG_DWORD /d 1 /f');
      cmds.push('reg add "HKCU\\Software\\Microsoft\\GameBar" /v AllowAutoGameMode /t REG_DWORD /d 1 /f');
      cmds.push('reg add "HKCU\\System\\GameConfigStore" /v GameDVR_Enabled /t REG_DWORD /d 0 /f');
      cmds.push('reg add "HKCU\\System\\GameConfigStore" /v GameDVR_FSEBehaviorMode /t REG_DWORD /d 2 /f');
      cmds.push('reg add "HKCU\\Control Panel\\Desktop" /v MenuShowDelay /t REG_SZ /d 0 /f');
    }

    for (const cmd of cmds) {
      await runCmd(cmd);
    }

    event.sender.send('precision-tweaks-reply', true);
  } catch (err) {
    event.sender.send('precision-tweaks-reply', false);
  }
});

ipcMain.on('revert-precision-tweaks', async (event) => {
  try {
    const cmds = [
      'reg add "HKCU\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d 1 /f',
      'reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold1 /t REG_SZ /d 6 /f',
      'reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold2 /t REG_SZ /d 10 /f',
      `reg add "HKCU\\Control Panel\\Mouse" /v SmoothMouseXCurve /t REG_BINARY /d ${DEFAULT_CURVE_X} /f`,
      `reg add "HKCU\\Control Panel\\Mouse" /v SmoothMouseYCurve /t REG_BINARY /d ${DEFAULT_CURVE_Y} /f`,
      'reg add "HKCU\\Control Panel\\Mouse" /v MouseHoverTime /t REG_SZ /d 400 /f',
      'reg add "HKCU\\Control Panel\\Desktop" /v MenuShowDelay /t REG_SZ /d 400 /f',
      'reg add "HKCU\\Control Panel\\Accessibility\\StickyKeys" /v Flags /t REG_SZ /d 510 /f',
      'reg add "HKCU\\Control Panel\\Accessibility\\Keyboard Response" /v Flags /t REG_SZ /d 126 /f',
      'reg add "HKCU\\Control Panel\\Accessibility\\ToggleKeys" /v Flags /t REG_SZ /d 62 /f'
    ];
    for (const cmd of cmds) {
      await runCmd(cmd);
    }
    if (user32SpiMouse) {
      try { user32SpiMouse(0x0004, 0, [6, 10, 1], 0x03); } catch (e) {}
    }
    event.sender.send('revert-tweaks-reply', true);
  } catch (err) {
    event.sender.send('revert-tweaks-reply', false);
  }
});

// --- IPC: TECLADOFIX (USA keyboard-tweaks.js) ---
ipcMain.on('apply-keyboard-tweaks', async (event, tweaks = {}) => {
  try {
    if (tweaks.precision) {
      await keyboardTweaks.aplicarPerfilPrecisao({
        incluirPrioridade: false,
        incluirUsb: Boolean(tweaks.usb)
      });
    } else {
      if (tweaks.delay) await keyboardTweaks.setAtrasoRepeticao(0);
      if (tweaks.rate) await keyboardTweaks.setTaxaRepeticao(31);
      if (tweaks.filterKeys || tweaks.bounce) await keyboardTweaks.setFilterKeys(false);
      if (tweaks.input) await keyboardTweaks.setStickyToggleKeys(false);
      if (tweaks.registros) await keyboardTweaks.aplicarAjustesRegistro();
      if (tweaks.usb) await keyboardTweaks.setSuspensaoUsbSeletiva(true);
    }
    event.sender.send('keyboard-tweaks-reply', { success: true });
  } catch (err) {
    event.sender.send('keyboard-tweaks-reply', { success: false, error: err.message });
  }
});

ipcMain.on('revert-keyboard-tweaks', async (event) => {
  try {
    await keyboardTweaks.restaurarPadrao();
    event.sender.send('revert-keyboard-tweaks-reply', { success: true });
  } catch (err) {
    event.sender.send('revert-keyboard-tweaks-reply', { success: false, error: err.message });
  }
});

// --- IPC: MIRA / CROSSHAIR OVERLAY E ATALHO GLOBAL ---
ipcMain.on('apply-mira', (event, { active } = {}) => {
  if (active) {
    const win = ensureCrosshairWindow();
    if (win && !win.isDestroyed()) {
      win.showInactive();
      win.webContents.send('set-visibility', true);
      if (lastCrosshairConfig) {
        win.webContents.send('update-crosshair', lastCrosshairConfig);
      }
    }
  } else if (crosshairWindow && !crosshairWindow.isDestroyed()) {
    crosshairWindow.webContents.send('set-visibility', false);
    crosshairWindow.hide();
  }
});

ipcMain.on('update-crosshair', (event, config) => {
  lastCrosshairConfig = config;
  if (crosshairWindow && !crosshairWindow.isDestroyed()) {
    crosshairWindow.webContents.send('update-crosshair', config);
  }
});

function toElectronAccelerator(keyStr) {
  if (!keyStr) return null;
  const map = {
    ' ': 'Space',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right'
  };
  return map[keyStr] || keyStr;
}

function browserButtonToUiohook(btn) {
  // Browser mousedown: 0=left, 1=middle, 2=right, 3=back, 4=forward
  // uiohook-napi: 1=left, 2=right, 3=middle, 4=back, 5=forward
  const map = { 0: 1, 1: 3, 2: 2, 3: 4, 4: 5 };
  return map[btn] ?? null;
}

ipcMain.on('set-mira-bind', (event, bind) => {
  if (currentKeyBind) {
    try { globalShortcut.unregister(currentKeyBind); } catch (e) {}
    currentKeyBind = null;
  }
  currentMouseBind = null;

  if (!bind) {
    event.sender.send('bind-status', { success: true });
    return;
  }

  if (bind.type === 'key' && bind.keyStr) {
    const accel = toElectronAccelerator(bind.keyStr);
    try {
      const ok = globalShortcut.register(accel, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('trigger-mira-bind');
        }
      });
      if (ok) currentKeyBind = accel;
      event.sender.send('bind-status', { keyStr: bind.keyStr, success: Boolean(ok) });
    } catch (err) {
      event.sender.send('bind-status', { keyStr: bind.keyStr, success: false });
    }
  } else if (bind.type === 'mouse' && bind.button !== undefined) {
    currentMouseBind = browserButtonToUiohook(bind.button);
    event.sender.send('bind-status', { success: currentMouseBind !== null });
  }
});

// --- IPC: ABRIR & OTIMIZAR FIVEM ---
ipcMain.on('launch-fivem', (event, opts = {}) => {
  try {
    if (opts.clearCache) {
      const dataPath = path.join(process.env.LOCALAPPDATA || '', 'FiveM', 'FiveM.app', 'data');
      ['cache', 'server-cache', 'server-cache-priv'].forEach((folder) => {
        const folderPath = path.join(dataPath, folder);
        try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch (e) {}
      });
    }

    if (opts.flushDns) {
      exec('ipconfig /flushdns', { windowsHide: true });
    }

    if (opts.closeApps) {
      ['chrome.exe', 'msedge.exe', 'opera.exe', 'Spotify.exe', 'OneDrive.exe'].forEach((proc) => {
        exec(`taskkill /F /IM "${proc}"`, { windowsHide: true });
      });
    }

    const fivemExe = path.join(process.env.LOCALAPPDATA || '', 'FiveM', 'FiveM.exe');
    if (fs.existsSync(fivemExe)) {
      exec(`start "" "${fivemExe}"`, { windowsHide: true });
      if (opts.highPriority) {
        setTimeout(() => {
          exec(
            'powershell -NoProfile -WindowStyle Hidden -Command "Get-Process FiveM_GTAProcess -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass = \'High\' }"',
            { windowsHide: true }
          );
        }, 12000);
      }
    }
  } catch (e) {}
});

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
          if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
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
          if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
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
  // Proteção anti-modificação / anti-intrusão (ativa na build protegida dos clientes)
  antiTamper.startAntiTamperWatchdog({
    app,
    dialog,
    appDir: __dirname,
    hmacSecret: global.__FORGOATS_HMAC_KEY || '',
    getUsername: () => activeSession?.username || '',
    getHwid: getClientHWID
  });

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

  // Inicia verificação automática de atualizações (OTA) para todos os usuários
  const updateCfg = updater.getUpdateConfig(__dirname);
  if (updateCfg.enabled && updateCfg.checkOnStartup !== false) {
    setTimeout(() => { void runAutoUpdateCheck(false); }, 2500);
  }
  if (updateCfg.enabled && Number(updateCfg.checkIntervalMinutes) > 0) {
    const intervalMs = Math.max(5, Number(updateCfg.checkIntervalMinutes)) * 60 * 1000;
    updateCheckTimer = setInterval(() => { void runAutoUpdateCheck(false); }, intervalMs);
  }

  try {
    uIOhook.on('mousedown', (event) => {
      if (currentMouseBind !== null && event.button === currentMouseBind) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('trigger-mira-bind');
        }
      }
    });
    uIOhook.start();
  } catch (e) {}
});

app.on('before-quit', () => {
  app.isQuiting = true;
  stopSessionMonitor();
  notifySessionLogout(activeSession);
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  try { globalShortcut.unregisterAll(); } catch (e) {}
  try { if (saturationModule) { saturationModule.reset(); saturationModule.cleanup(); } } catch (e) {}
  if (crosshairWindow && !crosshairWindow.isDestroyed()) {
    try { crosshairWindow.destroy(); } catch (e) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !minToTrayEnabled) {
    app.quit();
  }
});
