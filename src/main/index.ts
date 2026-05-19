import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, shell, clipboard, Notification } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { registerSystemHandlers, getActiveBrowserUrl } from "./system";

let commandWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isVisible = false;
let firstShow = true;
let lastKnownClipboard = "";
const ALL_SHORTCUTS = [
  "Control+Shift+Space",
  "Control+Shift+A",
  "Control+Alt+Space",
  "Control+Shift+K",
  "Control+Shift+O",
  "Control+Alt+A",
];
let currentShortcuts: string[] = ALL_SHORTCUTS;

// Doit être défini avant applyShortcut
function openWithCapture(): void {
  if (isVisible) { hideWindow(); return; }
  const current = clipboard.readText().trim();
  if (current.length > 30 && !/^https?:\/\//.test(current) && current !== lastKnownClipboard) {
    lastKnownClipboard = current;
  }
  showWindow();
}

function applyShortcut(shortcuts: string[]): void {
  globalShortcut.unregisterAll();
  const registered: string[] = [];
  const failed: string[] = [];
  shortcuts.forEach(s => {
    try {
      const ok = globalShortcut.register(s, openWithCapture);
      if (ok) registered.push(s); else failed.push(s + " (déjà pris)");
    } catch (e) { failed.push(s + " (erreur)"); }
  });
  currentShortcuts = shortcuts;
  console.log("[Omnyx] ✅ Raccourcis actifs:", registered.join(", "));
  if (failed.length) console.log("[Omnyx] ❌ Échoués:", failed.join(", "));
}


function createCommandWindow(): void {
  commandWindow = new BrowserWindow({
    width: 680,
    height: 520,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  if (!is.dev) {
    commandWindow.on("blur", () => { hideWindow(); });
  }

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    commandWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    commandWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function showWindow(): void {
  if (!commandWindow) return;
  if (firstShow) { commandWindow.center(); firstShow = false; }
  commandWindow.show();
  commandWindow.focus();
  isVisible = true;
  commandWindow.webContents.send("window-shown");
  // Détecter URL + titre
  getActiveBrowserUrl().then(({ url, title }) => {
    const signal = url || title;
    if (signal && commandWindow) commandWindow.webContents.send("url-changed", url || title, url);
  }).catch(() => {});
}

function hideWindow(): void {
  if (!commandWindow) return;
  commandWindow.hide();
  isVisible = false;
}

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: "Ouvrir Omnyx",          click: showWindow, accelerator: "Ctrl+Shift+Space" },
    { type: "separator" },
    {
      label: "Analyser la page courante", click: async () => {
        showWindow();
        await new Promise(r => setTimeout(r, 300));
        commandWindow?.webContents.send("action-analyze-page");
      }
    },
    {
      label: "Créer une tâche rapide", click: () => {
        showWindow();
        commandWindow?.webContents.send("action-quick-task");
      }
    },
    {
      label: "Mémoriser le presse-papiers", click: () => {
        const text = clipboard.readText().trim();
        if (text) {
          showWindow();
          commandWindow?.webContents.send("action-memorize", text);
        }
      }
    },
    { type: "separator" },
    { label: "Raccourci clavier…", click: () => showWindow() },
    { type: "separator" },
    { label: "Quitter Omnyx", click: () => app.quit() },
  ]);
}

function createTray(): void {
  const iconPath = is.dev
    ? join(app.getAppPath(), "src/main/tray-icon.png")
    : join(process.resourcesPath, "tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Omnyx — Ctrl+Shift+Space");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => isVisible ? hideWindow() : showWindow());
  // Rebuild on right-click to get fresh clipboard state
  tray.on("right-click", () => {
    tray?.setContextMenu(buildTrayMenu());
    tray?.popUpContextMenu();
  });
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.agentos");

  lastKnownClipboard = clipboard.readText().trim();

  // Surveiller le clipboard
  setInterval(() => {
    const current = clipboard.readText().trim();
    lastKnownClipboard = current;
  }, 500);

  // Vérification des tâches toutes les 60 secondes
  const notifiedTasks = new Set<string>();
  const reminderLastSent = new Map<string, number>(); // taskId → last notification timestamp

  setInterval(async () => {
    try {
      const token = commandWindow?.webContents
        ? await commandWindow.webContents.executeJavaScript(`localStorage.getItem('omnyx_token')`)
        : null;
      if (!token) return;
      const res = await fetch("http://localhost:8000/api/tasks/", { headers: { Authorization: `Bearer ${token}` } });
      const tasks = (await res.json()) as {
        id: string; title: string; priority: string; status: string;
        metadata?: { remind_at?: number; repeat_interval?: number };
      }[];
      const now = Date.now() / 1000; // timestamp en secondes

      for (const task of tasks) {
        if (task.status !== "pending") continue;

        // 1. Tâches urgentes (une seule fois)
        if (task.priority === "urgent" && !notifiedTasks.has(task.id)) {
          notifiedTasks.add(task.id);
          new Notification({ title: "Tâche urgente — Omnyx", body: task.title, silent: false }).show();
        }

        // 2. Rappels planifiés (remind_at + repeat_interval)
        const meta = task.metadata;
        if (meta?.remind_at && now >= meta.remind_at) {
          const lastSent = reminderLastSent.get(task.id) || 0;
          const repeatInterval = meta.repeat_interval || 0;
          const shouldNotify = lastSent === 0 || (repeatInterval > 0 && now - lastSent >= repeatInterval);
          if (shouldNotify) {
            reminderLastSent.set(task.id, now);
            new Notification({ title: "⏰ Rappel — Omnyx", body: task.title, silent: false }).show();
          }
        }
      }
    } catch {}
  }, 60 * 1000); // vérification chaque minute

  app.on("browser-window-created", (_, window) => { optimizer.watchWindowShortcuts(window); });

  createCommandWindow();
  createTray();
  registerSystemHandlers(ipcMain, shell);

  // Raccourcis par défaut
  applyShortcut(currentShortcuts);

  if (is.dev) { showWindow(); }

  ipcMain.handle("get-active-url", async () => JSON.stringify(await getActiveBrowserUrl()));
  ipcMain.handle("get-clipboard", () => clipboard.readText());
  ipcMain.on("hide-window", hideWindow);
  ipcMain.on("show-window", showWindow);
  ipcMain.on("resize-window", (_, { width, height }: { width: number; height: number }) => {
    if (commandWindow) { commandWindow.setSize(width, height); }
  });
  // Déduplication des notifications — même titre+body = affiché une seule fois par session
  const shownNotifications = new Map<string, number>(); // key → timestamp
  const NOTIF_COOLDOWN_MS = 60 * 60 * 1000; // 1 heure par défaut

  ipcMain.on("notify", (_, { title, body, force }: { title: string; body: string; force?: boolean }) => {
    const key = `${title}::${body}`;
    const lastShown = shownNotifications.get(key) || 0;
    const now = Date.now();
    if (!force && now - lastShown < NOTIF_COOLDOWN_MS) return; // déjà montrée
    shownNotifications.set(key, now);
    new Notification({ title, body, silent: false }).show();
  });
  ipcMain.on("schedule-reminder", (_, { title, delayMs, repeatMs }: { title: string; delayMs: number; repeatMs?: number }) => {
    const show = () => new Notification({ title: "⏰ Rappel — Omnyx", body: title, silent: false }).show();
    setTimeout(() => {
      show();
      if (repeatMs && repeatMs > 0) setInterval(show, repeatMs);
    }, delayMs);
  });

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createCommandWindow(); });
});

app.on("will-quit", () => { globalShortcut.unregisterAll(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
