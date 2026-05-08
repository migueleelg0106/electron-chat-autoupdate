const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

log.transports.file.level = 'info';
autoUpdater.logger = log;

let mainWindow;

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

function parseEnvFile(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .reduce((env, line) => {
      const separatorIndex = line.indexOf('=');

      if (separatorIndex === -1) {
        return env;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      env[key] = value;
      return env;
    }, {});
}

function loadEnvVariables() {
  const candidatePaths = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
    app.isPackaged ? path.join(process.resourcesPath, '.env') : null,
    app.isPackaged ? path.join(path.dirname(process.execPath), '.env') : null
  ].filter(Boolean);

  for (const envPath of candidatePaths) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const envValues = parseEnvFile(fs.readFileSync(envPath, 'utf8'));

    for (const [key, value] of Object.entries(envValues)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

function postJson(url, payload, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsedUrl = new URL(url);

    const request = https.request({
      hostname: parsedUrl.hostname,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      let responseBody = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });

      response.on('end', () => {
        let data;

        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          reject(new Error('Groq devolvio una respuesta invalida.'));
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = data.error?.message || `Groq respondio con estado ${response.statusCode}.`;
          reject(new Error(message));
          return;
        }

        resolve(data);
      });
    });

    request.on('error', (error) => {
      reject(error);
    });

    request.write(body);
    request.end();
  });
}

async function askGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error('Falta GROQ_API_KEY en el archivo .env.');
  }

  const response = await postJson(GROQ_API_URL, {
    model: process.env.GROQ_MODEL || GROQ_MODEL,
    temperature: 0.7,
    max_tokens: 700,
    messages: [
      {
        role: 'system',
        content: 'Responde en espanol claro y directo para pegarlo como mensaje en un chat local.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  }, apiKey);

  const answer = response.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    throw new Error('Groq no genero texto para esta solicitud.');
  }

  return answer;
}

loadEnvVariables();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#f7f5ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function sendUpdateStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', message);
  }
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('Buscando actualizaciones...');
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus(`Actualizacion disponible: ${info.version}. Descargando...`);
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus('La aplicacion ya esta actualizada.');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus(`Descargando actualizacion: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    sendUpdateStatus(`Version ${info.version} descargada. Reinicia para instalar.`);

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Reiniciar ahora', 'Despues'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualizacion lista',
      message: `La version ${info.version} ya se descargo.`,
      detail: 'Para instalarla, la aplicacion debe cerrarse y abrirse de nuevo.'
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error) => {
    sendUpdateStatus(`Error de actualizacion: ${error.message}`);
  });
}

app.whenReady().then(() => {
  createWindow();
  configureAutoUpdater();

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  } else {
    sendUpdateStatus('Auto-update desactivado en modo desarrollo.');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:check-updates', async () => {
  if (!app.isPackaged) {
    return 'Las actualizaciones solo se prueban en la app instalada.';
  }

  await autoUpdater.checkForUpdatesAndNotify();
  return 'Revision de actualizaciones iniciada.';
});

ipcMain.handle('ai:ask-groq', async (_event, prompt) => {
  const cleanPrompt = String(prompt || '').trim();

  if (!cleanPrompt) {
    return {
      ok: false,
      error: 'Escribe una instruccion despues de @groq.'
    };
  }

  try {
    return {
      ok: true,
      text: await askGroq(cleanPrompt)
    };
  } catch (error) {
    log.error('Groq request failed', error);

    return {
      ok: false,
      error: error.message || 'No se pudo generar la respuesta con Groq.'
    };
  }
});
