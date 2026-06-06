import { IpcMain, Shell } from "electron";
import { promisify } from "util";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(childProcess.exec);

function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/[éèêë]/g, "e").replace(/[àâä]/g, "a").replace(/[ùûü]/g, "u")
    .replace(/[îï]/g, "i").replace(/[ôö]/g, "o").replace(/[ç]/g, "c")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}


export async function getActiveBrowserUrl(): Promise<{ url: string; title: string }> {
  try {
    const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$browsers = @("chrome","msedge","firefox","brave","vivaldi","arc","thorium","waterfox","librewolf","floorp","zen")
foreach ($b in $browsers) {
  $p = Get-Process -Name $b -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 1
  if ($p) {
    $title = $p.MainWindowTitle
    $url = ""
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($edit) {
        $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $val = $vp.Current.Value
        if ($val -match "^https?://") { $url = $val }
      }
    } catch {}
    Write-Output "URL=$url"
    Write-Output "TITLE=$title"
    exit
  }
}
Write-Output "URL="
Write-Output "TITLE="`;
    const tmp = path.join(os.tmpdir(), "ao_browser_ctx.ps1");
    fs.writeFileSync(tmp, script, "utf8");
    const { stdout } = await execAsync(
      `powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "${tmp}"`,
      { timeout: 4000, windowsHide: true }
    );
    const urlMatch = stdout.match(/URL=(.*)/) ;
    const titleMatch = stdout.match(/TITLE=(.*)/);
    return {
      url: urlMatch ? urlMatch[1].trim() : "",
      title: titleMatch ? titleMatch[1].trim() : "",
    };
  } catch { return { url: "", title: "" }; }
}

export function registerSystemHandlers(ipcMain: IpcMain, shell: Shell): void {


  // Get browser URL — plusieurs méthodes en cascade
  ipcMain.handle("get-browser-url", async () => {
    const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$browsers = @("chrome","msedge","firefox","brave","opera","vivaldi","arc","thorium","waterfox","librewolf","floorp","zen")
$url = ""
$content = ""

foreach ($name in $browsers) {
  $proc = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if (-not $proc) { continue }

  $hwnd = $proc.MainWindowHandle

  # Methode 1 : UIAutomation sur tous les types de controles (Edit, Custom, Document)
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    # Chercher tous les patterns Value dans les descendants
    $conds = @(
      [System.Windows.Automation.ControlType]::Edit,
      [System.Windows.Automation.ControlType]::Custom,
      [System.Windows.Automation.ControlType]::ComboBox
    )
    foreach ($ct in $conds) {
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
      $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      foreach ($el in $elements) {
        try {
          $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $val = $vp.Current.Value
          if ($val -match "^https?://") { $url = $val; break }
        } catch {}
      }
      if ($url) { break }
    }
  } catch {}

  # Methode 2 : SendKeys Ctrl+L si UIAutomation n'a rien donne
  if (-not $url) {
    try {
      [Win32]::SetForegroundWindow($hwnd) | Out-Null
      Start-Sleep -Milliseconds 600
      [System.Windows.Forms.Clipboard]::Clear()
      [System.Windows.Forms.SendKeys]::SendWait("^l")
      Start-Sleep -Milliseconds 400
      [System.Windows.Forms.SendKeys]::SendWait("^c")
      Start-Sleep -Milliseconds 400
      $clip = [System.Windows.Forms.Clipboard]::GetText()
      if ($clip -match "^https?://") { $url = $clip.Trim() }
      [System.Windows.Forms.SendKeys]::SendWait("{ESCAPE}")
      Start-Sleep -Milliseconds 200
    } catch {}
  }

  # Methode 3 : titre de fenetre comme dernier recours (extrait domaine)
  if (-not $url) {
    $title = $proc.MainWindowTitle
    if ($title -match "[-|] (https?://\S+)") { $url = $Matches[1] }
  }

  if ($url) {
    # Tenter de recuperer le contenu de la page
    try {
      [Win32]::SetForegroundWindow($hwnd) | Out-Null
      Start-Sleep -Milliseconds 300
      [System.Windows.Forms.Clipboard]::Clear()
      [System.Windows.Forms.SendKeys]::SendWait("^a")
      Start-Sleep -Milliseconds 400
      [System.Windows.Forms.SendKeys]::SendWait("^c")
      Start-Sleep -Milliseconds 400
      $content = [System.Windows.Forms.Clipboard]::GetText()
    } catch {}
    break
  }
}

Write-Output "===URL==="
Write-Output $url
Write-Output "===CONTENT==="
Write-Output $content`;

    try {
      const tmp = path.join(os.tmpdir(), "ao_browser_url.ps1");
      fs.writeFileSync(tmp, script, "utf8");
      const { stdout } = await execAsync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { timeout: 10000 });
      const urlMatch = stdout.match(/===URL===\r?\n(.*)\r?\n/);
      const contentMatch = stdout.match(/===CONTENT===\r?\n([\s\S]*)/);
      const url = urlMatch ? urlMatch[1].trim() : "";
      const content = contentMatch ? contentMatch[1].trim().slice(0, 20000) : "";
      console.log(`[get-browser-url] url=${url.slice(0, 80)} content=${content.length}chars`);
      return JSON.stringify({ url, content });
    } catch (e) {
      console.error("[get-browser-url] error:", e);
      return JSON.stringify({ url: "", content: "" });
    }
  });

  // List all installed apps for autocomplete
  ipcMain.handle("list-apps", async () => {
    const script = `Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress`;
    try {
      const tmp = path.join(os.tmpdir(), "ao_list.ps1");
      fs.writeFileSync(tmp, script, "utf8");
      const { stdout } = await execAsync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { timeout: 20000 });
      if (stdout.trim()) {
        const raw = JSON.parse(stdout.trim());
        return Array.isArray(raw) ? raw : [raw];
      }
    } catch {}
    return [];
  });

  // Launch app directly by AppID (from Get-StartApps)
  ipcMain.handle("open-app-by-id", async (_, appId: string) => {
    if (!appId) return { success: false };
    if (appId.startsWith("{")) {
      // Win32 with GUID → resolve path
      const GUID_MAP: Record<string, string> = {
        "{6D809377-6AF0-444B-8957-A3773F02200E}": "C:\\Program Files",
        "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}": "C:\\Program Files (x86)",
      };
      let exePath = appId;
      for (const [guid, folder] of Object.entries(GUID_MAP)) {
        if (appId.toUpperCase().startsWith(guid.toUpperCase())) {
          exePath = folder + appId.substring(guid.length);
          break;
        }
      }
      const ps = path.join(os.tmpdir(), "ao_byid.ps1");
      fs.writeFileSync(ps, `Start-Process '${exePath.replace(/'/g, "''")}'`, "utf8");
      childProcess.spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", ps], { detached: true, stdio: "ignore" }).unref();
    } else {
      // UWP → shell:AppsFolder
      childProcess.spawn("explorer.exe", [`shell:AppsFolder\\${appId}`], { detached: true, stdio: "ignore" }).unref();
    }
    return { success: true };
  });

  ipcMain.handle("open-url", async (_, url: string) => {
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle("open-app", async (_, appName: string) => {
    // 1. Direct URI schemes for popular apps
    const URI_SCHEMES: [string[], string][] = [
      [["discord"],             "discord://"],
      [["spotify", "musique"],  "spotify://"],
      [["slack"],               "slack://"],
      [["zoom"],                "zoommtg://"],
      [["teams"],               "msteams://"],
    ];
    const n = normalize(appName);
    for (const [keys, uri] of URI_SCHEMES) {
      if (keys.some(k => n.includes(k))) {
        try { await shell.openExternal(uri); return { success: true }; } catch {}
        break;
      }
    }

    // 2. Search Start Menu shortcuts directly
    const homeDir = os.homedir();
    const startMenuDirs = [
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
      path.join(homeDir, "AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs"),
    ];

    const words = normalize(appName).split(" ").filter(w => w.length > 1);

    const matchScore = (shortcutName: string): number => {
      const base = normalize(shortcutName.replace(/\.lnk$/i, ""));
      const matched = words.filter(w => base.includes(w)).length;
      // Bonus if shortcut contains the full query
      if (base.includes(normalize(appName))) return 100;
      return Math.round((matched / words.length) * 100);
    };

    const collectShortcuts = (dir: string, results: {path: string; score: number}[] = []): typeof results => {
      if (!fs.existsSync(dir)) return results;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) collectShortcuts(full, results);
          else if (entry.name.match(/\.lnk$/i)) {
            const s = matchScore(entry.name);
            if (s > 0) results.push({ path: full, score: s });
          }
        }
      } catch {}
      return results;
    };

    // Search Start Menu + Desktop
    const searchDirsAll = [
      ...startMenuDirs,
      path.join(os.homedir(), "Desktop"),
      "C:\\Users\\Public\\Desktop",
    ];

    const allResults: {path: string; score: number}[] = [];
    for (const dir of searchDirsAll) {
      collectShortcuts(dir, allResults);
    }

    // Sort by score, pick best
    allResults.sort((a, b) => b.score - a.score);
    console.log("[open-app] best matches:", allResults.slice(0, 3).map(r => `${r.score} ${r.path}`));

    const best = allResults[0];
    if (best && best.score >= 30) {
      console.log("[open-app] launching shortcut:", best.path);
      childProcess.spawn("explorer.exe", [best.path], { detached: true, stdio: "ignore" }).unref();
      return { success: true };
    }

    // 3. Fallback: Get-StartApps for UWP apps (no .lnk shortcut)
    try {
      const script = `Get-StartApps | ConvertTo-Json -Compress`;
      const tmp = path.join(os.tmpdir(), "ao_startapps.ps1");
      fs.writeFileSync(tmp, script, "utf8");
      const { stdout } = await execAsync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { timeout: 10000 });
      if (stdout.trim()) {
        const raw = JSON.parse(stdout.trim());
        const apps: { Name: string; AppID: string }[] = Array.isArray(raw) ? raw : [raw];
        const queryNorm = normalize(appName);
        let bestApp = { name: "", appId: "", score: 0 };
        for (const app of apps) {
          if (!app.Name) continue;
          const appNorm = normalize(app.Name);
          let s = 0;
          if (appNorm === queryNorm) s = 100;
          else if (appNorm.includes(queryNorm) || queryNorm.includes(appNorm)) s = 80;
          else {
            const matched = words.filter(w => appNorm.includes(w)).length;
            s = Math.round((matched / words.length) * 60);
          }
          if (s > bestApp.score) bestApp = { name: app.Name, appId: app.AppID, score: s };
        }
        if (bestApp.score >= 40 && bestApp.appId) {
          const id = bestApp.appId;
          if (id.startsWith("{")) {
            // Win32 with GUID prefix → resolve to Program Files path
            const GUID_MAP: Record<string, string> = {
              "{6D809377-6AF0-444B-8957-A3773F02200E}": "C:\\Program Files",
              "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}": "C:\\Program Files (x86)",
            };
            let exePath = id;
            for (const [guid, folder] of Object.entries(GUID_MAP)) {
              if (id.toUpperCase().startsWith(guid.toUpperCase())) {
                exePath = folder + id.substring(guid.length);
                break;
              }
            }
            const psFile2 = path.join(os.tmpdir(), "ao_open2.ps1");
            fs.writeFileSync(psFile2, `Start-Process '${exePath.replace(/'/g, "''")}'`, "utf8");
            childProcess.spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", psFile2], { detached: true, stdio: "ignore" }).unref();
          } else {
            // UWP app → shell:AppsFolder
            childProcess.spawn("explorer.exe", [`shell:AppsFolder\\${id}`], { detached: true, stdio: "ignore" }).unref();
          }
          return { success: true };
        }
      }
    } catch {}

    return { success: false, error: `"${appName}" non trouvé` };
  });

  ipcMain.handle("open-path", async (_, filePath: string) => {
    const result = await shell.openPath(filePath);
    return { success: !result, error: result };
  });

  ipcMain.handle("search-files", async (_, query: string) => {
    try {
      const homeDir = os.homedir();
      const searchDirs = [
        path.join(homeDir, "Documents"),
        path.join(homeDir, "Downloads"),
        path.join(homeDir, "Desktop"),
      ];
      const results: string[] = [];
      for (const dir of searchDirs) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          const matches = files
            .filter(f => f.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 5)
            .map(f => path.join(dir, f));
          results.push(...matches);
        }
      }
      return { success: true, files: results.slice(0, 10) };
    } catch {
      return { success: false, files: [] };
    }
  });

  ipcMain.handle("get-system-info", async () => {
    return { platform: process.platform, homeDir: os.homedir(), username: os.userInfo().username };
  });
}
