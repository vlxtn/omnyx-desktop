import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, shell, clipboard, Notification, session } from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "path";
import * as fs from "fs";
import * as childProcess from "child_process";
import * as os from "os";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import WebSocket from "ws";
import { registerSystemHandlers, getActiveBrowserUrl } from "./system";

const API_BASE = "https://omnyx-backend-production.up.railway.app";

// Notification push : dès qu'une release est publiée sur GitHub, le backend
// nous prévient via ce WebSocket et on vérifie immédiatement les mises à jour.
function connectUpdateSocket(): void {
  const ws = new WebSocket(API_BASE.replace(/^http/, "ws") + "/api/ws/updates");
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "update_available") autoUpdater.checkForUpdates();
    } catch {}
  });
  ws.on("close", () => setTimeout(connectUpdateSocket, 10000));
  ws.on("error", () => ws.close());
}

let commandWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isVisible = false;
let lastKnownClipboard = "";
let manualUpdateCheck = false;
let selectionWatcher: childProcess.ChildProcess | null = null;

const SELECTION_HOOK_CS = `
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Text;

public class OmnyxSelectionHook {
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, LowLevelMouseProc fn, IntPtr mod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);

    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);
    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONUP = 514;
    const byte VK_CONTROL = 0x11;
    const byte VK_C = 0x43;

    static IntPtr hookId = IntPtr.Zero;
    static LowLevelMouseProc proc;
    static string lastReported = "";

    static IntPtr Callback(int code, IntPtr w, IntPtr l) {
        if (code >= 0 && (int)w == WM_LBUTTONUP) {
            Thread t = new Thread(() => {
                Thread.Sleep(120);
                string prev = "";
                try { if (Clipboard.ContainsText()) prev = Clipboard.GetText() ?? ""; } catch {}
                keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                keybd_event(VK_C, 0, 0, UIntPtr.Zero);
                keybd_event(VK_C, 0, 2, UIntPtr.Zero);
                keybd_event(VK_CONTROL, 0, 2, UIntPtr.Zero);
                Thread.Sleep(160);
                string cur = "";
                try { if (Clipboard.ContainsText()) cur = Clipboard.GetText() ?? ""; } catch {}
                if (cur != prev && cur.Length >= 10 && cur.Length <= 3000) {
                    // Marque ce contenu comme exclu du traitement "Actions suggérées" de Windows
                    // (popup de traduction/recherche qui apparaît sinon après chaque copie simulée)
                    try {
                        var data = new DataObject();
                        data.SetData(DataFormats.UnicodeText, cur);
                        data.SetData("ExcludeClipboardContentFromMonitorProcessing", true);
                        Clipboard.SetDataObject(data, true);
                    } catch {}
                    if (cur != lastReported) {
                        lastReported = cur;
                        Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(cur)));
                        Console.Out.Flush();
                    }
                }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }
        return CallNextHookEx(hookId, code, w, l);
    }

    public static void Start() {
        proc = Callback;
        hookId = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
        Application.Run();
    }
}
`;

function startSelectionWatcher(): void {
  if (selectionWatcher) return;
  const psFile = join(os.tmpdir(), "omnyx_sel_hook.ps1");
  const script = `Add-Type -TypeDefinition @'\n${SELECTION_HOOK_CS}\n'@ -ReferencedAssemblies System.Windows.Forms\n[OmnyxSelectionHook]::Start()`;
  fs.writeFileSync(psFile, script, "utf8");
  selectionWatcher = childProcess.spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", psFile], { windowsHide: true });
  selectionWatcher.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      const b64 = line.trim();
      if (!b64) continue;
      try {
        const text = Buffer.from(b64, "base64").toString("utf8");
        if (text.length >= 10) {
          if (isVisible) {
            commandWindow?.webContents.send("text-selected", text);
          } else {
            showWindow();
            setTimeout(() => commandWindow?.webContents.send("text-selected", text), 350);
          }
        }
      } catch {}
    }
  });
  selectionWatcher.on("exit", () => { selectionWatcher = null; });
}

function stopSelectionWatcher(): void {
  if (selectionWatcher) { selectionWatcher.kill(); selectionWatcher = null; }
}

function boundsFile(): string { return join(app.getPath("userData"), "companion-bounds.json"); }
function loadSavedBounds(): { x: number; y: number; width: number; height: number } | null {
  try { return JSON.parse(fs.readFileSync(boundsFile(), "utf8")); } catch { return null; }
}
function saveBounds(): void {
  if (!commandWindow) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify(commandWindow.getBounds()), "utf8"); } catch {}
}
async function captureScreenBase64(): Promise<string> {
  const tmpPng = join(os.tmpdir(), `omnyx_cap_${Date.now()}.png`);
  const psFile = join(os.tmpdir(), "omnyx_cap.ps1");
  const escaped = tmpPng.replace(/\\/g, "\\\\");
  fs.writeFileSync(psFile, `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height)
$g=[System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size)
$g.Dispose()
$b.Save('${escaped}',[System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()`, "utf8");
  await new Promise<void>((resolve, reject) =>
    childProcess.spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", psFile], { windowsHide: true })
      .on("close", code => code === 0 ? resolve() : reject(new Error(`ps exit ${code}`)))
  );
  const base64 = fs.readFileSync(tmpPng).toString("base64");
  try { fs.unlinkSync(tmpPng); } catch {}
  return base64;
}
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

function applyShortcut(shortcuts: string[], notifyOnStart = false): void {
  globalShortcut.unregisterAll();
  const registered: string[] = [];
  const failed: string[] = [];
  shortcuts.forEach(s => {
    try {
      const ok = globalShortcut.register(s, openWithCapture);
      if (ok) registered.push(s); else failed.push(s + " (déjà pris)");
    } catch (e) { failed.push(s + " (erreur)"); }
  });
  currentShortcuts = registered;
  console.log("[Omnyx] ✅ Raccourcis actifs:", registered.join(", "));
  if (failed.length) console.log("[Omnyx] ❌ Échoués:", failed.join(", "));
  if (notifyOnStart) {
    const body = registered.length > 0
      ? `Raccourci actif : ${registered[0]}`
      : "Aucun raccourci disponible — tous sont pris par d'autres apps.";
    new Notification({ title: "Omnyx est prêt", body, silent: true }).show();
  }
}


function createCommandWindow(): void {
  const saved = loadSavedBounds();
  commandWindow = new BrowserWindow({
    width: saved?.width ?? 680,
    height: saved?.height ?? 520,
    ...(saved ? { x: saved.x, y: saved.y } : { center: true }),
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => saveBounds(), 150);
  };
  commandWindow.on("move", debouncedSave);
  commandWindow.on("resize", debouncedSave);

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    commandWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    commandWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function showWindow(): void {
  if (!commandWindow) return;
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
  const shortcutHint = currentShortcuts.length > 0 ? currentShortcuts[0] : "Ctrl+Shift+Space";
  return Menu.buildFromTemplate([
    { label: `Ouvrir Omnyx  (${shortcutHint})`, click: showWindow },
    { label: "Ouvrir le tableau de bord", click: () => shell.openExternal("https://useomnyx.com") },
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
    {
      label: "Vérifier les mises à jour", click: () => {
        manualUpdateCheck = true;
        new Notification({ title: "Omnyx", body: "Recherche de mises à jour…", silent: true }).show();
        autoUpdater.checkForUpdates().catch(() => {});
      }
    },
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

  // Autoriser l'accès au microphone pour la reconnaissance vocale
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "media";
  });

  lastKnownClipboard = clipboard.readText().trim();

  let lastClipboardImageKey = "";
  let lastTextForSelection = "";
  let autoDetectTextEnabled = false;

  // Surveiller le clipboard (texte + images)
  setInterval(() => {
    const current = clipboard.readText().trim();

    // Détection texte sélectionné
    const isMeaningful = current.length >= 10 && current.length <= 3000
      && !/^https?:\/\//.test(current)
      && current !== lastTextForSelection;

    if (isMeaningful) {
      lastTextForSelection = current;
      if (isVisible) {
        commandWindow?.webContents.send("text-selected", current);
      } else if (autoDetectTextEnabled) {
        showWindow();
        setTimeout(() => commandWindow?.webContents.send("text-selected", current), 350);
      }
    }
    lastKnownClipboard = current;

    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const size = img.getSize();
      const key = `${size.width}x${size.height}`;
      if (key !== lastClipboardImageKey) {
        lastClipboardImageKey = key;
        const base64 = img.toPNG().toString("base64");
        commandWindow?.webContents.send("clipboard-image", base64);
      }
    } else {
      lastClipboardImageKey = "";
    }
  }, 800);

  ipcMain.on("set-auto-detect-text", (_, enabled: boolean) => {
    autoDetectTextEnabled = enabled;
    if (enabled) startSelectionWatcher();
    else stopSelectionWatcher();
  });

  // Vérification des tâches toutes les 60 secondes
  const notifiedTasks = new Set<string>();
  const reminderLastSent = new Map<string, number>(); // taskId → last notification timestamp

  setInterval(async () => {
    try {
      const token = commandWindow?.webContents
        ? await commandWindow.webContents.executeJavaScript(`localStorage.getItem('omnyx_token')`)
        : null;
      if (!token) return;
      const res = await fetch(`${API_BASE}/api/tasks/`, { headers: { Authorization: `Bearer ${token}` } });
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
  applyShortcut(currentShortcuts, !is.dev);

  if (is.dev) { showWindow(); }

  ipcMain.handle("get-active-url", async () => JSON.stringify(await getActiveBrowserUrl()));
  ipcMain.handle("get-clipboard", () => clipboard.readText());
  ipcMain.handle("write-clipboard", (_, text: string) => { clipboard.writeText(text); });
  ipcMain.on("hide-window", hideWindow);
  ipcMain.on("show-window", showWindow);

  let customShortcut: string | null = null;
  ipcMain.on("update-shortcut", (_, shortcut: string) => {
    // Ctrl+Shift+Space est TOUJOURS gardé + les autres défauts + le raccourci custom
    const toRegister = ALL_SHORTCUTS.includes(shortcut)
      ? ALL_SHORTCUTS
      : [...ALL_SHORTCUTS, shortcut];
    // Retirer l'ancien raccourci custom s'il existe et n'est pas dans les défauts
    const previous = customShortcut;
    customShortcut = shortcut;
    if (previous && !ALL_SHORTCUTS.includes(previous)) {
      const filtered = toRegister.filter(s => s !== previous);
      applyShortcut(filtered);
    } else {
      applyShortcut(toRegister);
    }
  });
  ipcMain.on("resize-window", (_, { width, height }: { width: number; height: number }) => {
    if (commandWindow) { commandWindow.setSize(width, height); }
  });
  ipcMain.on("set-resizable", (_, resizable: boolean) => {
    if (commandWindow) { commandWindow.setResizable(resizable); }
  });
  ipcMain.handle("capture-screen", async () => {
    if (!commandWindow) return { success: false };
    commandWindow.hide();
    await new Promise(r => setTimeout(r, 400));
    try {
      const base64 = await captureScreenBase64();
      commandWindow.show();
      commandWindow.focus();
      return { success: true, base64, mime_type: "image/png" };
    } catch (e) {
      commandWindow.show();
      return { success: false, error: String(e) };
    }
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

  // Retours visibles uniquement pour la vérification manuelle (menu tray) —
  // les vérifications automatiques (démarrage, push, 6h) restent silencieuses
  // sauf quand une mise à jour est effectivement prête à installer.
  autoUpdater.on("update-not-available", () => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      new Notification({ title: "Omnyx", body: "Tu as déjà la dernière version.", silent: true }).show();
    }
  });
  autoUpdater.on("update-available", (info) => {
    if (manualUpdateCheck) {
      new Notification({ title: "Omnyx", body: `Mise à jour ${info.version} trouvée — téléchargement…`, silent: true }).show();
    }
  });
  autoUpdater.on("error", (err) => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      new Notification({ title: "Omnyx", body: `Erreur lors de la vérification : ${err?.message || err}`, silent: true }).show();
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    manualUpdateCheck = false;
    new Notification({
      title: "Omnyx — Mise à jour prête",
      body: `Version ${info.version} sera installée au prochain lancement.`,
    }).show();
    autoUpdater.quitAndInstall(false, true);
  });

  // Auto-update — vérifie GitHub Releases au démarrage, puis se branche sur le
  // flux de notifications push du backend pour réagir instantanément à chaque
  // nouvelle release (filet de sécurité : re-vérif toutes les 6h en plus).
  if (!is.dev) {
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000);
    connectUpdateSocket();
  }
});

app.on("will-quit", () => { globalShortcut.unregisterAll(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
