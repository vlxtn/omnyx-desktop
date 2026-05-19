import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

const api = {
  hideWindow: () => ipcRenderer.send("hide-window"),
  showWindow: () => ipcRenderer.send("show-window"),
  openUrl: (url: string) => ipcRenderer.invoke("open-url", url),
  openApp: (appName: string) => ipcRenderer.invoke("open-app", appName),
  openPath: (filePath: string) => ipcRenderer.invoke("open-path", filePath),
  searchFiles: (query: string) => ipcRenderer.invoke("search-files", query),
  getSystemInfo: () => ipcRenderer.invoke("get-system-info"),
  listApps: () => ipcRenderer.invoke("list-apps"),
  openAppById: (appId: string) => ipcRenderer.invoke("open-app-by-id", appId),
  getClipboard: () => ipcRenderer.invoke("get-clipboard"),
  getBrowserUrl: () => ipcRenderer.invoke("get-browser-url"),
  notify: (title: string, body: string, force?: boolean) => ipcRenderer.send("notify", { title, body, force }),
  scheduleReminder: (title: string, delayMs: number, repeatMs?: number) => ipcRenderer.send("schedule-reminder", { title, delayMs, repeatMs }),
  updateShortcut: (shortcut: string) => ipcRenderer.send("update-shortcut", shortcut),
  resizeWindow: (width: number, height: number) => ipcRenderer.send("resize-window", { width, height }),
  getActiveUrl: () => ipcRenderer.invoke("get-active-url"),
  onWindowShown: (cb: () => void) => ipcRenderer.on("window-shown", cb),
  onUrlChanged: (cb: (signal: string, url: string) => void) => ipcRenderer.on("url-changed", (_, signal, url) => cb(signal, url)),
  onAnalyzePage: (cb: () => void) => ipcRenderer.on("action-analyze-page", cb),
  onQuickTask: (cb: () => void) => ipcRenderer.on("action-quick-task", cb),
  onMemorize: (cb: (text: string) => void) => ipcRenderer.on("action-memorize", (_, text) => cb(text)),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore
  window.electron = electronAPI;
  // @ts-ignore
  window.api = api;
}
