import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, Clock, FileText, Search, Zap, Smartphone, ArrowLeft, PanelRight, PanelTop, Sparkles, Globe, FolderOpen, ListChecks, Paperclip, Camera, PenLine, MousePointer2, Settings, Minimize2, Maximize2, CornerDownLeft, Copy, Check } from "lucide-react";
import logoImg from "./assets/logo.png";
import { useT } from "./i18n";
import { sendMessage, sendMessageStream, analyzeContent, analyzeImage, login, getTasks, completeTask, createTask, approveAction, Task, getConversations, getConversationMessages, searchConversations, SearchResult, Conversation, api, uploadFile } from "./api";
import { fetchStale } from "./stale";
import { detectContext, AppContext } from "./contexts";
import { generateSuggestions } from "./suggestions";
import ExecutivePanel from "./ExecutivePanel";

interface Message {
  role: "user" | "assistant";
  content: string;
  ts?: string;
  attachment?: string;
}

function now() { return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }

type ViewState = "login" | "chat";

const THEMES = {
  violet:   { label:"Violet",    border:"rgba(124,58,237,0.5)",   shadowRing:"rgba(124,58,237,0.2)",  headerBg:"rgba(99,102,241,0.12)", headerBgMid:"rgba(139,92,246,0.06)",  headerBorder:"rgba(124,58,237,0.2)",  userMsg:"linear-gradient(135deg,#4f46e5,#7c3aed)", accent:"#6366f1", accentLight:"#a5b4fc" },
  midnight: { label:"Minuit",    border:"rgba(29,78,216,0.5)",    shadowRing:"rgba(29,78,216,0.2)",   headerBg:"rgba(37,99,235,0.12)",  headerBgMid:"rgba(29,78,216,0.06)",   headerBorder:"rgba(29,78,216,0.2)",   userMsg:"linear-gradient(135deg,#1e3a8a,#1d4ed8)", accent:"#2563eb", accentLight:"#93c5fd" },
  emerald:  { label:"Émeraude",  border:"rgba(5,150,105,0.5)",    shadowRing:"rgba(5,150,105,0.2)",   headerBg:"rgba(5,150,105,0.1)",   headerBgMid:"rgba(16,185,129,0.05)",  headerBorder:"rgba(5,150,105,0.2)",   userMsg:"linear-gradient(135deg,#065f46,#059669)", accent:"#059669", accentLight:"#6ee7b7" },
  rose:     { label:"Rose",      border:"rgba(190,18,60,0.5)",    shadowRing:"rgba(190,18,60,0.2)",   headerBg:"rgba(190,18,60,0.1)",   headerBgMid:"rgba(236,72,153,0.05)",  headerBorder:"rgba(190,18,60,0.2)",   userMsg:"linear-gradient(135deg,#9d174d,#be185d)", accent:"#be185d", accentLight:"#f9a8d4" },
} as const;
type ThemeKey = keyof typeof THEMES;

const QUICK_ACTION_DEFS = [
  { icon: Globe,      color: "#6366f1", key: "quick_url",  prefixKey: "prefix_url"  },
  { icon: Smartphone, color: "#8b5cf6", key: "quick_app",  prefixKey: "prefix_app"  },
  { icon: FolderOpen, color: "#06b6d4", key: "quick_file", prefixKey: "prefix_file" },
  { icon: ListChecks, color: "#10b981", key: "quick_task", prefixKey: "prefix_task" },
];

export default function App() {
  const [view, setView] = useState<ViewState>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [analyseUrl, setAnalyseUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const lastPageRef = useRef<{ content: string; url: string } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pasteMode, setPasteMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [layout, setLayout] = useState<"horizontal" | "vertical">(() =>
    (localStorage.getItem("omnyx_layout") as "horizontal" | "vertical") || "horizontal"
  );
  const applyWindowSize = (l: "horizontal" | "vertical") => {
    // @ts-ignore
    window.api?.resizeWindow(l === "vertical" ? 420 : 720, l === "vertical" ? 740 : 560);
  };
  const toggleLayout = () => setLayout(l => {
    const next = l === "horizontal" ? "vertical" : "horizontal";
    localStorage.setItem("omnyx_layout", next);
    applyWindowSize(next);
    return next;
  });
  const toggleCompact = () => {
    setCompactMode(v => {
      const next = !v;
      if (next) {
        // @ts-ignore
        window.api?.resizeWindow(isVertical ? 420 : 660, 80);
        // @ts-ignore
        window.api?.setResizable(false);
      } else {
        // @ts-ignore
        window.api?.setResizable(true);
        applyWindowSize(layout);
      }
      return next;
    });
  };
  const isVertical = layout === "vertical";
  const [searchLoading, setSearchLoading] = useState(false);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const [pendingReminder, setPendingReminder] = useState<string | null>(null);
  const [pendingEvent, setPendingEvent] = useState<{ id: string; title: string; start: string; end: string; location?: string } | null>(null);
  const [reminderDelay, setReminderDelay] = useState<{ ms: number; label: string } | null>(null);
  const [currentContext, setCurrentContext] = useState<AppContext | null>(null);
  const [currentUrl, setCurrentUrl] = useState("");
  const [quickMemoryMode, setQuickMemoryMode] = useState(false);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [executiveMode, setExecutiveMode] = useState(false);
  const [briefing, setBriefing] = useState<string>("");
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [installedApps, setInstalledApps] = useState<{Name: string; AppID: string}[]>([]);
  const [suggestions, setSuggestions] = useState<{Name: string; AppID: string}[]>([]);
  const [language, setLanguage] = useState("fr");
  const [attachedFile, setAttachedFile] = useState<{ name: string; type: "image" | "text"; content?: string; base64?: string; mime_type?: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [hoveredMsgIdx, setHoveredMsgIdx] = useState<number | null>(null);
  const [pendingClipboardImage, setPendingClipboardImage] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const showTip = (e: React.MouseEvent, text: string) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setTooltip({ text, x: r.left + r.width / 2, y: r.bottom + 6 }); };
  const hideTip = () => setTooltip(null);
  const [autoDetectMode, setAutoDetectMode] = useState(false);
  const [writeForMeMode, setWriteForMeMode] = useState(false);
  const [writeForMePrompt, setWriteForMePrompt] = useState("");
  const [writeForMeResult, setWriteForMeResult] = useState("");
  const [writeForMeLoading, setWriteForMeLoading] = useState(false);
  const [writeFormat, setWriteFormat] = useState("email");
  const [writeTone, setWriteTone] = useState("professionnel");
  const [writeForMeAttach, setWriteForMeAttach] = useState<{ name: string; content: string } | null>(null);
  const [writeForMeCopied, setWriteForMeCopied] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [currentShortcut, setCurrentShortcut] = useState("Control+Shift+Space");
  const [pendingShortcut, setPendingShortcut] = useState("");
  const [compactMode, setCompactMode] = useState(false);
  const [agentTone, setAgentTone] = useState("equilibre");
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState<{content: string; ts?: string}[]>(() => {
    try { return JSON.parse(localStorage.getItem("omnyx_pinned") || "[]"); } catch { return []; }
  });
  const [showPinned, setShowPinned] = useState(false);
  const [theme, setTheme] = useState<ThemeKey>(() => (localStorage.getItem("omnyx_theme") as ThemeKey) || "violet");
  const [timerOpen, setTimerOpen] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(25 * 60);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerLabel, setTimerLabel] = useState("Pomodoro");
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [timerCustom, setTimerCustom] = useState("");
  const [timerTotal, setTimerTotal] = useState(25 * 60);
  const th = THEMES[theme];
  const flashSaved = () => { setSavedOk(true); setTimeout(() => setSavedOk(false), 1800); };
  const saveProfile = async (patch: Record<string, string>) => {
    setSavingSettings(true);
    try {
      await api.patch("/api/auth/profile", patch);
      try {
        const cached = localStorage.getItem("omnyx_desktop_profile_cache");
        if (cached) {
          const p = JSON.parse(cached);
          localStorage.setItem("omnyx_desktop_profile_cache", JSON.stringify({ ...p, ...patch }));
        }
      } catch {}
      flashSaved();
    } catch {}
    finally { setSavingSettings(false); }
  };
  const exportConversation = () => {
    if (messages.length === 0) return;
    const lines: string[] = [`# Conversation Omnyx — ${new Date().toLocaleDateString("fr-FR")}\n`];
    for (const m of messages) {
      const role = m.role === "user" ? "**Toi**" : "**Omnyx**";
      const ts = m.ts ? ` _(${m.ts})_` : "";
      lines.push(`### ${role}${ts}\n\n${m.content}\n`);
    }
    const blob = new Blob([lines.join("\n---\n\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `omnyx-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const writeForMeFileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const tr = useT(language);

  const loadTasks = useCallback(async () => {
    try {
      const data = await getTasks();
      const filtered = data.filter(t => t.status === "pending" || t.status === "in_progress");
      setTasks(filtered);
      try { localStorage.setItem("omnyx_desktop_tasks_cache", JSON.stringify(filtered)); } catch {}
    } catch (e) {
      console.error("[loadTasks]", e);
    }
  }, []);

  // Sauvegarder la conversation active entre les sessions
  useEffect(() => {
    if (activeConversationId) {
      localStorage.setItem("omnyx_companion_conv_id", activeConversationId);
    }
  }, [activeConversationId]);

  useEffect(() => {
    const token = localStorage.getItem("omnyx_token");
    if (token) {
      setView("chat");
      // Restaurer la dernière conversation
      const savedConvId = localStorage.getItem("omnyx_companion_conv_id");
      if (savedConvId) {
        setActiveConversationId(savedConvId);
        getConversationMessages(savedConvId).then(msgs => {
          if (msgs.length > 0) {
            setMessages(msgs.slice(-30).map(m => ({
              role: m.role as "user" | "assistant",
              content: m.content,
              ts: m.created_at ? new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : undefined,
            })));
          }
        }).catch(() => {});
      }
      // Afficher les tâches cachées immédiatement
      try {
        const cachedTasks = localStorage.getItem("omnyx_desktop_tasks_cache");
        if (cachedTasks) setTasks(JSON.parse(cachedTasks));
      } catch {}
      // Appliquer la langue + ton depuis le cache profil
      try {
        const cachedProfile = localStorage.getItem("omnyx_desktop_profile_cache");
        if (cachedProfile) {
          const p = JSON.parse(cachedProfile);
          if (p.language) setLanguage(p.language);
          if (p.agent_tone) setAgentTone(p.agent_tone);
          if (p.companion_shortcut) setCurrentShortcut(p.companion_shortcut);
        }
      } catch {}
      // Sync profil depuis le backend
      api.get("/api/auth/me").then(({ data }) => {
        if (data.companion_shortcut) {
          // @ts-ignore
          window.api?.updateShortcut(data.companion_shortcut);
          setCurrentShortcut(data.companion_shortcut);
        }
        setLanguage(data.language || "fr");
        if (data.agent_tone) setAgentTone(data.agent_tone);
        try { localStorage.setItem("omnyx_desktop_profile_cache", JSON.stringify(data)); } catch {}
      }).catch(() => {});
    }
    // Chargement des apps installées en arrière-plan
    // @ts-ignore
    window.api?.listApps().then((apps: {Name: string; AppID: string}[]) => {
      if (apps?.length) setInstalledApps(apps);
    }).catch(() => {});
  }, []);

  useEffect(() => { applyWindowSize(layout); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view !== "chat") return;
    loadTasks();
    const interval = setInterval(loadTasks, 30000);
    return () => clearInterval(interval);
  }, [view, loadTasks]);

  useEffect(() => {
    if (view === "chat") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [view]);

  // Re-déclencher l'animation + détecter le contexte à chaque ouverture
  useEffect(() => {
    // @ts-ignore
    window.api?.onWindowShown(() => {
      const el = document.querySelector(".ao-window") as HTMLElement | null;
      if (el) { el.style.animation = "none"; el.offsetHeight; el.style.animation = ""; }
      setDismissedSuggestions(new Set());
    });
    // Détecter le contexte via titre + URL
    // @ts-ignore
    window.api?.onUrlChanged((signal: string, url: string) => {
      if (url) setCurrentUrl(url);
      setCurrentContext(detectContext(url || signal));
    });

    // Actions depuis le menu contextuel tray
    // @ts-ignore
    window.api?.onAnalyzePage(async () => {
      // @ts-ignore
      const raw: string = await window.api?.getBrowserUrl() || "{}";
      let pageData: { url?: string; content?: string } = {};
      try { pageData = JSON.parse(raw); } catch {}
      const content = (pageData.content || "").trim();
      const url = pageData.url || "";
      if (content.length > 50 || url) {
        setMessages(prev => [...prev, { role: "user" as const, content: `Analyse cette page${url ? ` : ${url}` : ""}`, ts: now() }]);
        try {
          const { analyzeContent } = await import("./api");
          const data = await analyzeContent(content, undefined, url || undefined);
          setMessages(prev => [...prev, { role: "assistant" as const, content: data.result || "", ts: now() }]);
        } catch {}
      }
    });
    // @ts-ignore
    window.api?.onQuickTask(() => {
      setInput("Crée une tâche : ");
      setTimeout(() => inputRef.current?.focus(), 100);
    });
    // @ts-ignore
    window.api?.onMemorize((text: string) => {
      setMessages(prev => [...prev, { role: "user" as const, content: `Mémorise : "${text.slice(0,100)}"`, ts: now() }]);
      import("./api").then(({ api: apiClient }) => {
        apiClient.post("/api/memory/", { content: text, memory_type: "long_term" })
          .then(() => setMessages(prev => [...prev, { role: "assistant" as const, content: `⭐ Mémorisé : "${text.slice(0,80)}"`, ts: now() }]))
          .catch(() => {});
      });
    });

    // Détection image dans le presse-papiers
    // @ts-ignore
    window.api?.onClipboardImage?.((base64: string) => {
      setPendingClipboardImage(base64);
    });

  }, []);


  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Touche Echap pour fermer la fenêtre
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // @ts-ignore
        window.api?.hideWindow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Capture de raccourci clavier
  useEffect(() => {
    if (!capturingShortcut) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const modifiers: string[] = [];
      if (e.ctrlKey) modifiers.push("Control");
      if (e.shiftKey) modifiers.push("Shift");
      if (e.altKey) modifiers.push("Alt");
      if (e.metaKey) modifiers.push("Meta");
      const IGNORED = ["Control", "Shift", "Alt", "Meta", "Escape", "Tab"];
      if (IGNORED.includes(e.key)) return;
      const KEY_MAP: Record<string, string> = { " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right" };
      const key = KEY_MAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      if (modifiers.length === 0) return;
      const shortcut = [...modifiers, key].join("+");
      setPendingShortcut(shortcut);
      setCapturingShortcut(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingShortcut]);

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    try {
      const data = await login(email, password);
      localStorage.setItem("omnyx_token", data.access_token);
      setView("chat");
      // Appliquer le raccourci configuré
      if (data.user?.companion_shortcut) {
        // @ts-ignore
        window.api?.updateShortcut(data.user.companion_shortcut);
      }
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const isNetwork = (err as { code?: string })?.code === "ECONNREFUSED" || (err as { code?: string })?.code === "ERR_NETWORK";
      if (isNetwork || !status) {
        setLoginError(tr("err_network"));
      } else if (status === 401) {
        setLoginError(tr("err_credentials"));
      } else {
        setLoginError(`Erreur ${status}`);
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const handleIntent = useCallback(async (text: string) => {
    const norm = (s: string) => s.toLowerCase()
      .replace(/[éèêë]/g, "e").replace(/[àâä]/g, "a").replace(/[ùûü]/g, "u")
      .replace(/[îï]/g, "i").replace(/[ôö]/g, "o").replace(/[ç]/g, "c")
      .replace(/[‘’ʼ´`]/g, "'");
    const _norm2 = (s: string) => s.toLowerCase()
      .replace(/[éèêë]/g, "e").replace(/[àâä]/g, "a").replace(/[ùûü]/g, "u")
      .replace(/[îï]/g, "i").replace(/[ôö]/g, "o").replace(/[ç]/g, "c")
      .replace(/'/g, "'");
    const t = norm(text);

    const APP_MAP: Record<string, string> = {
      "discord": "discord", "spotify": "spotify", "musique": "spotify", "music": "spotify",
      "chrome": "chrome", "google": "chrome", "navigateur": "chrome", "browser": "chrome",
      "firefox": "firefox", "vscode": "vscode", "code": "vscode", "visual studio": "vscode",
      "explorateur": "explorer", "fichiers": "explorer", "explorer": "explorer",
      "notepad": "notepad", "bloc note": "notepad", "bloc-note": "notepad", "editeur": "notepad", "blocnote": "notepad",
      "calculatrice": "calculatrice", "calculette": "calculatrice", "calc": "calculatrice",
      "terminal": "terminal", "console": "terminal", "invite de commande": "terminal",
      "word": "word", "traitement de texte": "word",
      "excel": "excel", "tableur": "excel",
      "outlook": "outlook", "messagerie": "outlook",
      "teams": "teams", "slack": "slack", "zoom": "zoom",
      "steam": "steam", "notion": "notion", "paint": "paint",
      "telegram": "telegram", "whatsapp": "whatsapp", "gestionnaire": "taskmgr",
    };

    const OPEN_WORDS = ["ouvre", "lance", "demarre", "start", "open", "mets", "active", "utilise", "accede", "besoin", "veux", "peux tu ouvrir", "peut tu ouvrir", "pourrais tu ouvrir"];
    // Mots sans ambiguïté : si l'app n'est pas reconnue, on tente quand même de
    // l'ouvrir. Les autres (veux, mets, utilise...) sont trop fréquents dans des
    // phrases normales pour servir à deviner un nom d'appli inconnu.
    const STRONG_OPEN_WORDS = ["ouvre", "lance", "demarre", "start", "open", "peux tu ouvrir", "peut tu ouvrir", "pourrais tu ouvrir"];
    const FILE_WORDS = ["trouve", "cherche", "recherche", "localise", "ou est"];

    // Rappel / reminder → ouvre directement le panneau de fréquence
    const REMINDER_WORDS = [
      "rappelle-moi de ", "rappelle moi de ", "rappelle-moi d'", "rappelle moi d'",
      "rappelle-toi de ", "rappelle toi de ",
      "n'oublie pas de ", "noublie pas de ", "oublie pas de ",
      "souviens-toi de ", "souviens toi de ",
      "pense a ", "fais-moi penser a ", "fais moi penser a ",
      "cree un rappel ", "creer un rappel ", "mets un rappel ", "met un rappel ", "ajoute un rappel ",
      "remind me to ", "remind me of ", "don't forget to ", "dont forget to ", "remember to ",
    ];
    const reminderMatch = REMINDER_WORDS.find(w => t.includes(_norm2(w)));
    if (reminderMatch) {
      const idx = t.indexOf(_norm2(reminderMatch));
      const title = text.slice(idx + reminderMatch.length).trim().replace(/[?.!]+$/, "");
      if (title) {
        setPendingReminder(title);
        return { handled: true, result: `D'accord, configurons ton rappel pour : "${title}"` };
      }
    }

    // Créer une tâche directement via l'API
    const TASK_WORDS = [
      "cree une tache", "cree la tache", "ajoute une tache", "nouvelle tache", "ajoute la tache",
      "todo:", "a faire:", "task:", "ajoute a ma liste", "note de faire",
    ];
    const hasTask = TASK_WORDS.some(w => t.includes(w));
    if (hasTask) {
      const title = text
        .replace(/cré[ea]\s+(une|la)\s+tâche\s*/i, "")
        .replace(/ajoute\s+(une|la)\s+tâche\s*/i, "")
        .replace(/nouvelle\s+tâche\s*/i, "")
        .replace(/très\s+urgent[e]?s?|très\s+important[e]?|extrêmement\s+important[e]?|critique/gi, "")
        .replace(/urgent[e]?s?|haute\s+priorité?|important[e]?|basse|faible|priorité?\s*\w*/gi, "")
        .replace(/[,"""]/g, "").replace(/\s+/g, " ").trim();
      if (title) {
        // Afficher le sélecteur de priorité au lieu de créer directement
        setPendingTask(title);
        return { handled: true, result: `Quelle priorité pour "${title}" ?` };
      }
    }

    // "Fais une capture d'écran" → ouvre l'outil de capture natif Windows (Win+Maj+S), modifiable/annotable ensuite
    const TAKE_SCREENSHOT_WORDS = [
      "capture d'ecran", "capture decran", "capture ecran", "capture de l'ecran",
      "capture mon ecran", "capture l'ecran", "screenshot",
      "fais une capture", "fait une capture", "prends une capture", "prend une capture",
      "fais un screenshot", "prends un screenshot",
      "un screen", "le screen", "ce screen",
    ];
    const hasTakeScreenshot = TAKE_SCREENSHOT_WORDS.some(w => t.includes(norm(w)))
      || /captur\w*.{0,8}ecran/.test(t) || /ecran.{0,8}captur\w*/.test(t);

    // Toute question/demande mentionnant "écran" (hors demande de capture) → capture + analyse, réponse directe
    const hasAnalyzeScreen = !hasTakeScreenshot && /\becran\b/.test(t);

    if (hasTakeScreenshot) {
      try {
        // @ts-ignore
        await window.api?.openUrl("ms-screenclip:");
        return { handled: true, result: "✂️ Outil de capture d'écran ouvert — sélectionne ta zone, elle s'ouvrira dans l'éditeur pour que tu puisses l'annoter et l'enregistrer." };
      } catch {
        return { handled: true, result: "Impossible d'ouvrir l'outil de capture d'écran." };
      }
    }

    if (hasAnalyzeScreen) {
      try {
        // @ts-ignore
        const result = await window.api?.captureScreen();
        if (result?.success && result.base64) {
          const question = text || "Analyse cet écran.";
          const data = await analyzeImage(result.base64, "image/png", question, activeConversationId);
          if (data.conversation_id) setActiveConversationId(data.conversation_id);
          return { handled: true, result: data.result || "" };
        }
        return { handled: true, result: "Impossible de capturer l'écran." };
      } catch {
        return { handled: true, result: "Erreur lors de la capture d'écran." };
      }
    }

    const hasOpen = OPEN_WORDS.some(w => t.includes(norm(w)));
    const hasStrongOpen = STRONG_OPEN_WORDS.some(w => t.includes(norm(w)));
    const hasFile = FILE_WORDS.some(w => t.includes(norm(w)));
    const looksLikeUrl = /\.(com|fr|io|net|org|co|app|dev)/.test(t) || t.includes("http") || t.includes("www");

    // Detect app anywhere in the text
    const foundAppKey = Object.keys(APP_MAP).sort((a, b) => b.length - a.length).find(k => t.includes(norm(k)));

    // Open app — known, ou inconnu si déclenché par un mot d'ouverture explicite
    if (hasOpen && !looksLikeUrl) {
      let appName = "";
      if (foundAppKey) {
        appName = APP_MAP[foundAppKey];
      } else if (hasStrongOpen) {
        const candidate = text.replace(/^.*(ouvre|lance|demarre|start|open|peux tu ouvrir|peut tu ouvrir|pourrais tu ouvrir)\s+/i, "").replace(/[?!.]/g, "").trim();
        // Un nom d'appli est court — une phrase entière n'en est pas un.
        if (candidate && candidate.split(/\s+/).length <= 4) appName = candidate;
      }
      if (appName) {
        // @ts-ignore
        const result = await window.api?.openApp(appName);
        return { handled: true, result: result?.success ? `✓ ${appName} ouvert` : `✗ "${appName}" introuvable — vérifie qu'il est installé` };
      }
    }

    const hasAction = t.includes(" et ") || t.includes(" puis ") || t.includes(" ensuite ");

    // Analyze current page — seulement si la phrase parle d'une page/article/url
    const pageKeywords = ["cette page", "cet article", "cette url", "ce site", "cette video", "cette vidéo", "ce lien", "analyze this", "resume cette page", "résume cette page", "analyse cette page"];
    const hasAnalyse = pageKeywords.some(k => t.includes(norm(k)));
    if (hasAnalyse) {
      // Try to find URL in the message itself first
      const urlInMsg = text.match(/https?:\/\/[^\s]+/);
      let pageUrl = urlInMsg ? urlInMsg[0] : null;

      // If no URL in message, try clipboard
      if (!pageUrl) {
        try {
          // @ts-ignore
          const clipText: string = await window.api?.getClipboard() || "";
          const clipUrl = clipText.match(/https?:\/\/[^\s]+/);
          if (clipUrl) pageUrl = clipUrl[0];
        } catch {}
      }

      if (pageUrl) {
        try {
          const data = await sendMessage(`${tr("analyze_send")} : ${pageUrl}`, "research");
          const response = data.message?.content || data.clean_content || "Analyse terminée.";
          return { handled: true, result: response };
        } catch {
          return { handled: true, result: "Erreur de connexion au backend." };
        }
      }
      return { handled: true, result: "📋 Copie l'URL de la page (Ctrl+L → Ctrl+C dans le navigateur), puis tape 'analyse cette page'." };
    }

    // Smart search URLs — "va sur X et recherche Y" → direct search URL
    const SEARCH_ENGINES: Record<string, string> = {
      "youtube": "https://youtube.com/results?search_query=",
      "google": "https://google.com/search?q=",
      "twitter": "https://twitter.com/search?q=",
      "x.com": "https://twitter.com/search?q=",
      "github": "https://github.com/search?q=",
      "reddit": "https://reddit.com/search/?q=",
      "amazon": "https://amazon.fr/s?k=",
      "linkedin": "https://linkedin.com/search/results/all/?keywords=",
    };
    // Detect site + search query in any order/phrasing
    const searchVerbs = ["recherche", "cherche", "trouve", "search", "montre", "trouve moi"];
    const hasSearchVerb = searchVerbs.some(v => t.includes(v));
    if (hasSearchVerb) {
      // Find which site
      let matchedSite = "";
      let matchedUrl = "";
      for (const [site, baseUrl] of Object.entries(SEARCH_ENGINES)) {
        if (t.includes(site)) { matchedSite = site; matchedUrl = baseUrl; break; }
      }
      if (matchedSite) {
        // Extract query — everything that's not the site name or action verbs
        let query = t
          .replace(/va sur|ouvre|aller sur|navigue vers/g, "")
          .replace(new RegExp(matchedSite.replace(".", "\\."), "g"), "")
          .replace(/et |puis |ensuite |recherche |cherche |trouve |search |montre moi |montre |des |les |le |la |un |une /g, " ")
          .replace(/\.com|\.fr|\.io/g, "")
          .replace(/\s+/g, " ").trim();
        if (query.length > 1) {
          // @ts-ignore
          await window.api?.openUrl(matchedUrl + encodeURIComponent(query));
          return { handled: true, result: `✓ Recherche "${query}" sur ${matchedSite}` };
        }
      }
    }

    // Navigation "va sur [site]" — site name without extension
    const NAV_WORDS = ["va sur", "aller sur", "navigue vers", "ouvre le site", "ouvre le site de", "go to", "ouvre nike", "visite"];
    const hasNav = NAV_WORDS.some(w => t.includes(w));
    if (hasNav && !hasSearchVerb) {
      const SITE_MAP: Record<string, string> = {
        "nike": "https://nike.com", "adidas": "https://adidas.fr", "amazon": "https://amazon.fr",
        "youtube": "https://youtube.com", "google": "https://google.com", "gmail": "https://gmail.com",
        "facebook": "https://facebook.com", "instagram": "https://instagram.com", "twitter": "https://twitter.com",
        "x": "https://x.com", "linkedin": "https://linkedin.com", "github": "https://github.com",
        "netflix": "https://netflix.com", "spotify": "https://open.spotify.com", "twitch": "https://twitch.tv",
        "reddit": "https://reddit.com", "leboncoin": "https://leboncoin.fr", "vinted": "https://vinted.fr",
        "zara": "https://zara.com/fr", "hm": "https://hm.com/fr", "fnac": "https://fnac.com",
        "cdiscount": "https://cdiscount.com", "boulanger": "https://boulanger.com",
        "apple": "https://apple.com/fr", "microsoft": "https://microsoft.com",
        "notion": "https://notion.so", "figma": "https://figma.com",
        "chatgpt": "https://chat.openai.com", "openai": "https://openai.com",
        "perplexity": "https://perplexity.ai", "claude": "https://claude.ai",
      };
      // Extract site name from message
      let siteName = t;
      for (const w of NAV_WORDS) siteName = siteName.replace(w, "");
      siteName = siteName.replace(/^(le site de|le site|le|la|les|un|une|sur)\s+/g, "").replace(/[?!.]/g, "").trim();
      const matchedUrl = SITE_MAP[siteName] || (siteName.length > 2 ? `https://${siteName}.com` : null);
      if (matchedUrl) {
        // @ts-ignore
        await window.api?.openUrl(matchedUrl);
        return { handled: true, result: `J'ouvre ${siteName.charAt(0).toUpperCase() + siteName.slice(1)} dans ton navigateur.` };
      }
    }

    // Open URL — but if there's an action ("et", "puis"), let the agent handle it
    if (looksLikeUrl && !foundAppKey && !hasAction) {
      const urlMatch = text.match(/https?:\/\/[^\s]+|[\w-]+\.[a-z]{2,}[^\s]*/i);
      if (urlMatch) {
        const finalUrl = urlMatch[0].startsWith("http") ? urlMatch[0] : `https://${urlMatch[0]}`;
        // @ts-ignore
        await window.api?.openUrl(finalUrl);
        return { handled: true, result: `✓ Ouverture de ${finalUrl}` };
      }
    }

    // Search files — not if URL is in the text
    if (hasFile && !hasOpen && !looksLikeUrl && !hasAction) {
      const query = text.replace(/^(trouve|cherche|recherche|localise|ou est)\s+/i, "").trim();
      // @ts-ignore
      const result = await window.api?.searchFiles(query);
      if (result?.files?.length > 0) {
        setFileResults(result.files);
        return { handled: true, result: `${result.files.length} fichier${result.files.length > 1 ? "s" : ""} trouvé${result.files.length > 1 ? "s" : ""} — clique pour ouvrir` };
      }
      return { handled: true, result: `Aucun fichier trouvé pour "${query}"` };
    }

    return { handled: false };
  }, [activeConversationId]);

  const executeAction = useCallback(async (action: { action_type: string; data: Record<string, string> }) => {
    const { action_type, data } = action;
    if (action_type === "browser_navigate" && data.url) {
      // @ts-ignore
      await window.api?.openUrl(data.url);
      return `✓ Navigation vers ${data.url}`;
    }
    if (action_type === "open_app" && data.app_name) {
      // @ts-ignore
      const result = await window.api?.openApp(data.app_name);
      return result?.success ? `✓ ${data.app_name} ouvert` : `✗ Impossible d'ouvrir ${data.app_name}`;
    }
    if (action_type === "search_files" && data.query) {
      // @ts-ignore
      const result = await window.api?.searchFiles(data.query);
      if (result?.files?.length > 0) return `📁 ${result.files.slice(0, 5).join("\n")}`;
      return `Aucun fichier trouvé`;
    }
    return null;
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");

    const currentAttachment = attachedFile;
    setAttachedFile(null);

    let apiMessage = text;

    if (currentAttachment?.type === "text" && currentAttachment.content) {
      apiMessage = `${text}\n\n📎 ${currentAttachment.name}:\n\`\`\`\n${currentAttachment.content.slice(0, 8000)}\n\`\`\``;
    }

    const userMsg: Message = { role: "user", content: text, ts: now(), attachment: currentAttachment?.name };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      // 1. Intention locale rapide (ouvrir app/URL) — seulement sans fichier joint
      if (!currentAttachment) {
        const intent = await handleIntent(text);
        if (intent.handled) {
          setMessages(prev => [...prev, { role: "assistant", content: intent.result ?? "" }]);
          setLoading(false);
          setTimeout(() => inputRef.current?.focus(), 50);
          return;
        }
      }

      // 2. Image attachée → endpoint dédié
      if (currentAttachment?.type === "image" && currentAttachment.base64) {
        try {
          const result = await analyzeImage(currentAttachment.base64, currentAttachment.mime_type || "image/png", text || "Analyse cette image.", activeConversationId);
          if (result.conversation_id) setActiveConversationId(result.conversation_id);
          setMessages(prev => [...prev, { role: "assistant", content: result.result || "" }]);
        } catch (e: any) {
          const detail = e?.response?.data?.detail || e?.message || "Erreur inconnue";
          const status = e?.response?.status;
          setMessages(prev => [...prev, { role: "assistant", content: `Erreur${status ? ` ${status}` : ""} : ${detail}` }]);
        } finally {
          setLoading(false);
          setTimeout(() => inputRef.current?.focus(), 50);
        }
        return;
      }

      // 3. Si une page a été analysée, toute question suivante utilise son contenu comme contexte
      if (lastPageRef.current && !currentAttachment) {
        const { content, url } = lastPageRef.current;
        const data = await analyzeContent(content, text, url || undefined);
        setMessages(prev => [...prev, { role: "assistant", content: data.result || "" }]);
        setLoading(false);
        setTimeout(() => inputRef.current?.focus(), 50);
        return;
      }

      // 3. Envoi en streaming — les tokens arrivent au fur et à mesure
      const assistantTs = now();
      setMessages(prev => [...prev, { role: "assistant", content: "", ts: assistantTs }]);
      let fullContent = "";
      let doneData: { actions?: { action_type: string; data: Record<string, string> }[]; clean_content?: string } | null = null;

      for await (const event of sendMessageStream(apiMessage, "executive", activeConversationId)) {
        if (event.type === "start" && event.conversation_id) {
          setActiveConversationId(event.conversation_id);
        } else if (event.type === "delta") {
          fullContent += event.content;
          setMessages(prev => {
            const msgs = [...prev];
            msgs[msgs.length - 1] = { role: "assistant", content: fullContent };
            return msgs;
          });
        } else if (event.type === "done") {
          doneData = event;
          if (event.clean_content) {
            fullContent = event.clean_content;
            setMessages(prev => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = { role: "assistant", content: fullContent };
              return msgs;
            });
          }
        } else if (event.type === "error") {
          setMessages(prev => {
            const msgs = [...prev];
            msgs[msgs.length - 1] = { role: "assistant", content: `Erreur : ${event.message}` };
            return msgs;
          });
        }
      }

      // Exécuter les actions proposées par l'agent
      if (doneData?.actions?.length) {
        const actionResults: string[] = [];
        for (const action of doneData.actions.slice(0, 3)) {
          if (action.action_type === "create_task" && action.data?.title) {
            setPendingTask(action.data.title);
            continue;
          }
          if (action.action_type === "schedule_event" && (action as any).id && action.data?.title) {
            setPendingEvent({ id: (action as any).id, title: action.data.title, start: action.data.start, end: action.data.end, location: action.data.location });
            continue;
          }
          const result = await executeAction(action);
          if (result) actionResults.push(result);
        }
        if (actionResults.length > 0) {
          setMessages(prev => {
            const msgs = [...prev];
            msgs[msgs.length - 1] = { role: "assistant", content: fullContent + "\n\n" + actionResults.join("\n") };
            return msgs;
          });
        }
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: tr("conn_error") }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, handleIntent, executeAction]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const generateWriteForMe = async () => {
    if (!writeForMePrompt.trim() || writeForMeLoading) return;
    setWriteForMeLoading(true);
    setWriteForMeResult("");
    setWriteForMeCopied(false);
    const FORMAT_LABELS: Record<string, string> = { email: "un email", message: "un message", post: "un post réseaux sociaux", rapport: "un rapport", autre: "un texte" };
    const TONE_LABELS: Record<string, string> = { professionnel: "professionnel", decontracte: "décontracté et naturel", creatif: "créatif et original", persuasif: "persuasif et convaincant" };
    const attachContext = writeForMeAttach
      ? `\n\nPièce jointe — ${writeForMeAttach.name}:\n\`\`\`\n${writeForMeAttach.content.slice(0, 6000)}\n\`\`\``
      : "";
    const prompt = `Rédige ${FORMAT_LABELS[writeFormat]} avec un ton ${TONE_LABELS[writeTone]}. Sujet : ${writeForMePrompt.trim()}${attachContext}\n\nRéponds UNIQUEMENT avec le texte rédigé, sans explication ni introduction.`;
    let full = "";
    try {
      for await (const event of sendMessageStream(prompt, "executive", null)) {
        if (event.type === "delta") { full += event.content; setWriteForMeResult(full); }
        else if (event.type === "done" && event.clean_content) { setWriteForMeResult(event.clean_content); full = event.clean_content; }
      }
    } catch { setWriteForMeResult("Erreur de génération."); }
    finally { setWriteForMeLoading(false); }
  };


  useEffect(() => {
    if (timerRunning) {
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds(s => {
          if (s <= 1) {
            clearInterval(timerIntervalRef.current!);
            setTimerRunning(false);
            // @ts-ignore
            window.api?.notify("⏱ Omnyx — Timer", `${timerLabel} terminé !`);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } else {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    }
    return () => { if (timerIntervalRef.current) clearInterval(timerIntervalRef.current); };
  }, [timerRunning, timerLabel]);

  const timerFmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;


  if (view === "login") {
    return (
      <div style={styles.overlay}>
        <div style={styles.window} className="ao-window">
          <div style={styles.header}>
            <img src={logoImg} alt="Omnyx" style={{ width:32, height:32, borderRadius:10, objectFit:"cover", flexShrink:0 }} />
            <span style={styles.logoText}>Omnyx</span>
          </div>
          <p style={styles.subtitle}>{tr("login_subtitle")}</p>
          <form onSubmit={doLogin} style={styles.form}>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="Email" style={styles.input} required autoFocus
            />
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" style={styles.input} required
            />
            {loginError && <p style={styles.error}>{loginError}</p>}
            <button type="submit" disabled={loginLoading} style={styles.button}>
              {loginLoading ? tr("login_connecting") : tr("login_submit")}
            </button>
          </form>
          <p style={styles.hint}>{tr("login_esc")}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.overlay}>
      {tooltip && (
        <div style={{ position:"fixed", left:tooltip.x, top:tooltip.y, transform:"translateX(-50%)", background:"rgba(10,10,20,0.95)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:6, padding:"4px 9px", fontSize:10, color:"rgba(255,255,255,0.85)", whiteSpace:"nowrap" as const, zIndex:9999, pointerEvents:"none" as const, boxShadow:"0 4px 12px rgba(0,0,0,0.5)", letterSpacing:"0.02em" }}>
          {tooltip.text}
        </div>
      )}
      <div style={{
        ...styles.window,
        border: `1px solid ${th.border}`,
        boxShadow: `0 0 0 1px ${th.shadowRing}, 0 30px 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)`,
        ...(isVertical ? { width: 380, maxHeight: 680, minHeight: 300 } : { width: 660, maxHeight: 500 }),
        ...(compactMode ? { borderRadius: 8, minHeight: 0 } : {}),
      }} className="ao-window">
        {/* En-tête — zone de déplacement */}
        <div style={{
          ...styles.header,
          background: `linear-gradient(135deg, ${th.headerBg} 0%, ${th.headerBgMid} 50%, transparent 100%)`,
          borderBottom: `1px solid ${th.headerBorder}`,
          ...(isVertical && !compactMode ? { flexWrap: "wrap" as const, gap: 8 } : {}),
          ...(compactMode ? { padding: "12px 14px", gap: 8 } : {}),
        }} className="drag">
          {/* Logo + titre */}
          <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
            <img src={logoImg} alt="Omnyx" style={{ width:compactMode ? 26 : 32, height:compactMode ? 26 : 32, borderRadius:8, objectFit:"cover", flexShrink:0, transition:"all 0.15s" }} />
            {!compactMode && <span className="ao-logo-text" style={{ fontSize: 14, flexShrink: 0 }}>Omnyx</span>}
          </div>
          {/* Toggle layout — masqué en compact */}
          {!compactMode && (
            <button className="no-drag" title=""
              onClick={toggleLayout}
              onMouseEnter={e => showTip(e, isVertical ? "Mode horizontal" : "Mode vertical")} onMouseLeave={hideTip}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.08)", cursor:"pointer", flexShrink:0, marginLeft: isVertical ? "auto" : 0 }}>
              {isVertical
                ? <PanelTop size={12} color="#7dd3fc" />
                : <PanelRight size={12} color="#7dd3fc" />}
            </button>
          )}
          <div style={{ flex: 1, position: "relative" as const, display:"flex", alignItems:"center", gap:4, ...(isVertical && !compactMode ? { flexBasis:"100%", order: 10 } : {}) }}>
            <input
              ref={inputRef}
              className="no-drag"
              value={input}
              onChange={e => {
                const v = e.target.value;
                setInput(v);
                // Suggestions d'apps
                if (v.length >= 2 && installedApps.length > 0) {
                  const q = v.toLowerCase().replace(/^(ouvre|lance|demarre|open)\s+/i, "");
                  const matches = installedApps.filter(a => a.Name.toLowerCase().includes(q)).slice(0, 4);
                  setSuggestions(matches);
                } else {
                  setSuggestions([]);
                }
                // Suggestions fichiers — actives quand l'input commence par "trouve "
                if (fileSearchTimer.current) clearTimeout(fileSearchTimer.current);
                const fileQuery = v.replace(/^(trouve|cherche|find|localise)\s+/i, "");
                const isFileMode = fileQuery !== v && fileQuery.length >= 1;
                if (isFileMode) {
                  fileSearchTimer.current = setTimeout(async () => {
                    try {
                      // @ts-ignore
                      const result = await window.api?.searchFiles(fileQuery);
                      setFileSuggestions((result?.files || []).slice(0, 6));
                    } catch { setFileSuggestions([]); }
                  }, 250);
                } else {
                  setFileSuggestions([]);
                }
              }}
              onKeyDown={onKey}
              onBlur={() => setTimeout(() => { setSuggestions([]); setFileSuggestions([]); }, 150)}
              placeholder={tr("placeholder")}
              style={styles.mainInput}
              disabled={loading}
            />
            {/* Bouton expand inline — visible uniquement en compact */}
            {compactMode && (
              <button className="no-drag"
                onClick={toggleCompact}
                style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, cursor:"pointer", border:"1px solid rgba(99,102,241,0.35)", background:"rgba(99,102,241,0.15)", flexShrink:0 }}>
                <Maximize2 size={12} color="#a5b4fc" />
              </button>
            )}
            {!compactMode && <button className="no-drag" title=""
              onMouseEnter={e => showTip(e, "Joindre un fichier")} onMouseLeave={hideTip}
              onClick={() => {
                // @ts-ignore
                window.api?.lockWindow();
                fileInputRef.current?.click();
                // Déverrouiller quand le focus revient (dialog fermée ou annulée)
                const onFocus = () => setTimeout(() => {
                  // @ts-ignore
                  window.api?.unlockWindow();
                }, 300);
                window.addEventListener("focus", onFocus, { once: true });
              }}
              disabled={fileLoading}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, cursor: fileLoading ? "not-allowed" : "pointer", border: attachedFile ? "1px solid rgba(99,102,241,0.4)" : "1px solid rgba(255,255,255,0.07)", background: attachedFile ? "rgba(99,102,241,0.18)" : "rgba(255,255,255,0.04)", transition:"all 0.15s", opacity: fileLoading ? 0.5 : 1, flexShrink:0 }}>
              <Paperclip size={13} color={attachedFile ? "#a5b4fc" : "#c4b5fd"} />
            </button>}
            <button className="no-drag ao-send-btn"
              onClick={send}
              disabled={loading || !input.trim()}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor: (loading || !input.trim()) ? "not-allowed" : "pointer", border:"none", background: (input.trim() && !loading) ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "rgba(255,255,255,0.06)", opacity: (input.trim() && !loading) ? 1 : 0.35, flexShrink:0, transition:"all 0.2s" }}>
              <CornerDownLeft size={13} color="white" />
            </button>
            <input ref={fileInputRef} type="file" style={{ display:"none" }}
              accept="image/*,.pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.html,.css,.xml,.docx"
              onChange={async (e) => {
                // @ts-ignore
                window.api?.unlockWindow();
                const file = e.target.files?.[0];
                if (!file) return;
                setFileLoading(true);
                try {
                  const data = await uploadFile(file);
                  setAttachedFile({ name: data.name, type: data.type, content: data.content, base64: data.base64, mime_type: data.mime_type });
                } catch { /* silent */ } finally {
                  setFileLoading(false);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }
              }}
            />
            {suggestions.length > 0 && (
              <div style={styles.suggestions}>
                {suggestions.map((app, i) => (
                  <button key={i} style={styles.suggestionItem} className="ao-suggestion"
                    onMouseDown={() => {
                      setSuggestions([]);
                      setInput("");
                      // @ts-ignore
                      // @ts-ignore
                      window.api?.openApp(app.Name).then(() => {
                        setMessages(prev => [...prev,
                          { role: "user", content: `Ouvre ${app.Name}` },
                          { role: "assistant", content: `✓ ${app.Name} ouvert` }
                        ]);
                      });
                    }}>
                    <Smartphone size={14} color="#a5b4fc" />
                    <span style={styles.suggestionName}>{app.Name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* ── Toolbar groupée — masquée en compact ── */}
          {!compactMode && <div style={{ display:"flex", alignItems:"center", gap:2, padding:"3px", borderRadius:10, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", flexShrink:0, ...(isVertical ? { order:11 } : {}) }}>
            {/* Brain — Executive */}
            <button className="no-drag ao-icon-btn" title=""
              onClick={() => { setBriefing(""); setExecutiveMode(v => !v); }}
              onMouseEnter={e => showTip(e, "Mode Executive")} onMouseLeave={hideTip}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"none", background: executiveMode ? "rgba(99,102,241,0.3)" : "transparent" }}>
              <Brain size={14} color={executiveMode ? "#a5b4fc" : "#818cf8"} />
            </button>
            {/* Clock — Historique */}
            <button className="no-drag ao-icon-btn" title=""
              onClick={() => {
                if (!historyOpen) fetchStale<Conversation[]>("/api/chat/conversations", setConversations);
                setHistoryOpen(v => !v);
              }}
              onMouseEnter={e => showTip(e, "Historique des conversations")} onMouseLeave={hideTip}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"none", background: historyOpen ? "rgba(96,165,250,0.25)" : "transparent" }}>
              <Clock size={14} color={historyOpen ? "#93c5fd" : "#60a5fa"} />
            </button>
            {/* FileText — Coller */}
            <button className="no-drag ao-icon-btn" title=""
              onClick={() => setPasteMode(v => !v)}
              onMouseEnter={e => showTip(e, "Coller & analyser du texte")} onMouseLeave={hideTip}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"none", background: pasteMode ? "rgba(34,211,238,0.2)" : "transparent" }}>
              <FileText size={14} color={pasteMode ? "#67e8f9" : "#22d3ee"} />
            </button>
            {/* Sparkles — Mémoriser */}
            <button className="no-drag ao-icon-btn" title=""
              onClick={() => { setQuickMemoryMode(v => !v); setPasteMode(false); }}
              onMouseEnter={e => showTip(e, "Mémoriser quelque chose")} onMouseLeave={hideTip}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"none", background: quickMemoryMode ? "rgba(245,158,11,0.25)" : "transparent" }}>
              <Sparkles size={14} color={quickMemoryMode ? "#fde68a" : "#fbbf24"} />
            </button>
            {/* Camera — Capture d'écran */}
            <button className="no-drag ao-icon-btn" title=""
              onMouseEnter={e => showTip(e, "Capturer & analyser l'écran avec l'IA")} onMouseLeave={hideTip}
              disabled={loading || fileLoading}
              onClick={async () => {
                setFileLoading(true);
                try {
                  // @ts-ignore
                  const result = await window.api?.captureScreen();
                  if (result?.success && result.base64) {
                    const blob = await fetch(`data:image/png;base64,${result.base64}`).then(r => r.blob());
                    const file = new File([blob], "capture-ecran.png", { type: "image/png" });
                    const data = await uploadFile(file);
                    setAttachedFile({ name: data.name, type: data.type, content: data.content, base64: data.base64, mime_type: data.mime_type });
                    setInput(prev => prev || "Analyse cet écran");
                    setTimeout(() => inputRef.current?.focus(), 100);
                  }
                } catch { /* silent */ } finally { setFileLoading(false); }
              }}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor: (loading || fileLoading) ? "not-allowed" : "pointer", border:"none", background:"transparent", opacity: (loading || fileLoading) ? 0.4 : 1 }}>
              <Camera size={14} color="#f472b6" />
            </button>
            {/* MousePointer2 — Détection texte sélectionné */}
            <button className="no-drag ao-icon-btn" title=""
              onMouseEnter={e => showTip(e, autoDetectMode ? "Désactiver la détection de texte" : "Détecter le texte sélectionné")} onMouseLeave={hideTip}
              onClick={() => {
                const next = !autoDetectMode;
                setAutoDetectMode(next);
                // @ts-ignore
                window.api?.setAutoDetectText(next);
              }}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"none", background: autoDetectMode ? "rgba(16,185,129,0.25)" : "transparent" }}>
              <MousePointer2 size={14} color={autoDetectMode ? "#6ee7b7" : "#34d399"} />
            </button>
            {/* PenLine — Écris pour moi */}
            <button className="no-drag ao-icon-btn" title=""
              onMouseEnter={e => showTip(e, "Écris pour moi")} onMouseLeave={hideTip}
              onClick={() => { setWriteForMeMode(v => !v); setPasteMode(false); setQuickMemoryMode(false); }}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"none", background: writeForMeMode ? "rgba(251,146,60,0.2)" : "transparent" }}>
              <PenLine size={14} color={writeForMeMode ? "#fdba74" : "#fb923c"} />
            </button>
            {/* Séparateur */}
            <div style={{ width:1, height:14, background:"rgba(255,255,255,0.08)", margin:"0 2px" }}/>
            {/* Badge tâches */}
            {tasks.length > 0 && (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, borderRadius:6, background: tasks.some(t => t.priority === "urgent") ? "rgba(244,63,94,0.2)" : "rgba(99,102,241,0.2)", padding:"0 4px" }}>
                <span style={{ fontSize:10, fontWeight:700, color: tasks.some(t => t.priority === "urgent") ? "#f87171" : "#a5b4fc" }}>{tasks.length}</span>
              </div>
            )}
          </div>}
          {!compactMode && <button
            className="no-drag"
            title=""
            onMouseEnter={e => showTip(e, "Analyser la page actuelle")} onMouseLeave={hideTip}
            disabled={loading}
            style={{ display:"flex", alignItems:"center", justifyContent:"center", width:30, height:30, borderRadius:9, cursor: loading ? "not-allowed" : "pointer", flexShrink:0, border:"1px solid rgba(99,102,241,0.25)", background:"rgba(99,102,241,0.1)", opacity: loading ? 0.4 : 1, transition:"all 0.15s" }}
            onClick={async () => {
              setLoading(true);
              // @ts-ignore
              window.api?.hideWindow();
              await new Promise(r => setTimeout(r, 500));
              try {
                // Capture d'écran + URL en parallèle
                const [screenshotResult, rawBrowser] = await Promise.all([
                  // @ts-ignore
                  window.api?.captureScreen().catch(() => null),
                  // @ts-ignore
                  window.api?.getBrowserUrl().catch(() => "{}"),
                ]);
                // @ts-ignore
                window.api?.showWindow();

                let pageUrl = "";
                try {
                  const parsed = JSON.parse(rawBrowser || "{}");
                  pageUrl = parsed.url || "";
                } catch {}

                const userLabel = `Analyse cette page${pageUrl ? ` : ${pageUrl}` : ""}`;
                setMessages(prev => [...prev, { role: "user" as const, content: userLabel, ts: now() }]);

                // Toujours utiliser la capture d'écran si disponible — fonctionne même sur les pages authentifiées
                if (screenshotResult?.success && screenshotResult.base64) {
                  const question = `Analyse en détail ce qui est affiché sur cette page.${pageUrl ? ` URL : ${pageUrl}` : ""} Décris le contenu, les informations clés, le statut, les données importantes, et tout ce qui est pertinent pour l'utilisateur.`;
                  const result = await analyzeImage(screenshotResult.base64, "image/png", question, activeConversationId);
                  if (result.conversation_id) setActiveConversationId(result.conversation_id);
                  setMessages(prev => [...prev, { role: "assistant" as const, content: result.result || "", ts: now() }]);
                } else {
                  setMessages(prev => [...prev, { role: "assistant" as const, content: "Impossible de capturer l'écran. Vérifie que Chrome est ouvert et réessaie." }]);
                }
              } catch (err: unknown) {
                // @ts-ignore
                window.api?.showWindow();
                const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
                const msg = detail || (err as { message?: string })?.message || "Erreur inconnue";
                setMessages(prev => [...prev, { role: "assistant", content: `Erreur : ${msg}` }]);
              } finally { setLoading(false); }
            }}>
            <Search size={13} color="#a5b4fc" />
          </button>}
          {!compactMode && loading && <div style={styles.spinner} />}
        </div>

        {/* Tout le contenu est masqué en mode compact */}
        {!compactMode && <>

        {/* Bannière image presse-papiers détectée */}
        {pendingClipboardImage && (
          <div style={{ padding:"5px 16px", background:"rgba(139,92,246,0.08)", borderBottom:"1px solid rgba(139,92,246,0.2)", display:"flex", alignItems:"center", gap:8 }}>
            <Camera size={11} color="#a78bfa" />
            <span style={{ fontSize:11, color:"#c4b5fd", flex:1 }}>Image copiée détectée</span>
            <button onClick={async () => {
              const b64 = pendingClipboardImage;
              setPendingClipboardImage(null);
              const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob());
              const file = new File([blob], "clipboard.png", { type:"image/png" });
              setFileLoading(true);
              try {
                const data = await uploadFile(file);
                setAttachedFile({ name: data.name, type: data.type, content: data.content, base64: data.base64, mime_type: data.mime_type });
              } catch {} finally { setFileLoading(false); }
            }} style={{ background:"rgba(139,92,246,0.2)", border:"1px solid rgba(139,92,246,0.4)", borderRadius:6, padding:"3px 10px", fontSize:10, color:"#c4b5fd", cursor:"pointer" }}>
              Joindre
            </button>
            <button onClick={() => setPendingClipboardImage(null)} style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.25)", fontSize:13, padding:0 }}>✕</button>
          </div>
        )}

        {/* Panel paramètres */}
        {shortcutOpen && (
          <div style={{ padding:"14px 16px", background:"rgba(10,10,22,0.99)", borderBottom:"1px solid rgba(255,255,255,0.07)", display:"flex", flexDirection:"column" as const, gap:16 }}>

            {/* En-tête panneau */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:11, fontWeight:700, color:"rgba(165,180,252,0.6)", letterSpacing:"0.05em" }}>Paramètres</span>
                {savingSettings && <span style={{ fontSize:10, color:"rgba(165,180,252,0.4)" }}>Enregistrement…</span>}
                {savedOk && <span style={{ fontSize:10, color:"#34d399", fontWeight:600 }}>✓ Enregistré</span>}
              </div>
              <button className="no-drag" onClick={() => { setShortcutOpen(false); setCapturingShortcut(false); setPendingShortcut(""); }}
                style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.3)", fontSize:16, padding:"0 2px", lineHeight:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
                ✕
              </button>
            </div>

            {/* Langue de l'IA */}
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"rgba(165,180,252,0.45)", textTransform:"uppercase" as const, letterSpacing:"0.09em", marginBottom:8 }}>Langue de l'IA</div>
              <div style={{ display:"flex", gap:5, flexWrap:"wrap" as const }}>
                {([
                  { code:"fr", flag:"🇫🇷", label:"FR" },
                  { code:"en", flag:"🇬🇧", label:"EN" },
                  { code:"es", flag:"🇪🇸", label:"ES" },
                  { code:"de", flag:"🇩🇪", label:"DE" },
                  { code:"it", flag:"🇮🇹", label:"IT" },
                  { code:"pt", flag:"🇵🇹", label:"PT" },
                ]).map(lang => (
                  <button key={lang.code} className="no-drag"
                    onClick={() => { setLanguage(lang.code); saveProfile({ language: lang.code }); }}
                    style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:8, border: language === lang.code ? "1px solid rgba(99,102,241,0.6)" : "1px solid rgba(255,255,255,0.08)", background: language === lang.code ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.04)", color: language === lang.code ? "#a5b4fc" : "rgba(255,255,255,0.4)", fontSize:12, cursor:"pointer", transition:"all 0.15s", fontFamily:"inherit" }}>
                    <span>{lang.flag}</span>
                    <span style={{ fontWeight: language === lang.code ? 700 : 400 }}>{lang.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Ton de l'IA */}
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"rgba(165,180,252,0.45)", textTransform:"uppercase" as const, letterSpacing:"0.09em", marginBottom:8 }}>Ton de l'IA</div>
              <div style={{ display:"flex", gap:5, flexWrap:"wrap" as const }}>
                {([
                  { value:"equilibre",      label:"Équilibré",     color:"#a5b4fc" },
                  { value:"professionnel",  label:"Professionnel", color:"#60a5fa" },
                  { value:"decontracte",    label:"Décontracté",   color:"#34d399" },
                  { value:"technique",      label:"Technique",     color:"#f472b6" },
                ]).map(tone => (
                  <button key={tone.value} className="no-drag"
                    onClick={() => { setAgentTone(tone.value); saveProfile({ agent_tone: tone.value }); }}
                    style={{ padding:"5px 12px", borderRadius:8, border: agentTone === tone.value ? `1px solid ${tone.color}60` : "1px solid rgba(255,255,255,0.08)", background: agentTone === tone.value ? `${tone.color}1a` : "rgba(255,255,255,0.04)", color: agentTone === tone.value ? tone.color : "rgba(255,255,255,0.4)", fontSize:11, cursor:"pointer", transition:"all 0.15s", fontFamily:"inherit", fontWeight: agentTone === tone.value ? 600 : 400 }}>
                    {tone.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Thème */}
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"rgba(165,180,252,0.45)", textTransform:"uppercase" as const, letterSpacing:"0.09em", marginBottom:8 }}>Thème</div>
              <div style={{ display:"flex", gap:5 }}>
                {(Object.entries(THEMES) as [ThemeKey, typeof THEMES[ThemeKey]][]).map(([key, t]) => (
                  <button key={key} className="no-drag"
                    onClick={() => { setTheme(key); localStorage.setItem("omnyx_theme", key); }}
                    style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 10px", borderRadius:8, border: theme === key ? `1px solid ${t.border}` : "1px solid rgba(255,255,255,0.08)", background: theme === key ? `${t.shadowRing}` : "rgba(255,255,255,0.04)", color: theme === key ? t.accentLight : "rgba(255,255,255,0.4)", fontSize:11, cursor:"pointer", transition:"all 0.15s", fontFamily:"inherit", fontWeight: theme === key ? 700 : 400 }}>
                    <span style={{ width:8, height:8, borderRadius:"50%", background: t.accent, flexShrink:0, display:"inline-block", boxShadow: theme === key ? `0 0 6px ${t.accent}` : "none" }}/>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Séparateur */}
            <div style={{ height:1, background:"rgba(255,255,255,0.05)" }} />

            {/* Raccourci clavier */}
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"rgba(165,180,252,0.45)", textTransform:"uppercase" as const, letterSpacing:"0.09em", marginBottom:8 }}>Raccourci clavier</div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div
                  onClick={() => { setCapturingShortcut(true); setPendingShortcut(""); }}
                  style={{ flex:1, padding:"7px 10px", borderRadius:8, border: capturingShortcut ? "1px solid rgba(99,102,241,0.6)" : "1px solid rgba(255,255,255,0.1)", background: capturingShortcut ? "rgba(99,102,241,0.1)" : "rgba(255,255,255,0.04)", cursor:"pointer", fontSize:12, color: capturingShortcut ? "#a5b4fc" : "rgba(255,255,255,0.7)", fontFamily:"'Courier New',monospace", textAlign:"center" as const, transition:"all 0.15s" }}>
                  {capturingShortcut ? "Appuie sur ta combinaison…" : (pendingShortcut || currentShortcut)}
                </div>
                <button
                  onClick={async () => {
                    const s = pendingShortcut || currentShortcut;
                    await saveProfile({ companion_shortcut: s });
                    // @ts-ignore
                    window.api?.updateShortcut(s);
                    setCurrentShortcut(s);
                    setPendingShortcut("");
                  }}
                  style={{ padding:"7px 14px", borderRadius:8, border:"1px solid rgba(99,102,241,0.4)", background:"rgba(99,102,241,0.2)", color:"#a5b4fc", fontSize:11, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" as const }}>
                  {savingSettings ? "…" : "Enregistrer"}
                </button>
              </div>
              <p style={{ fontSize:10, color:"rgba(255,255,255,0.18)", marginTop:5, marginBottom:0 }}>Clique sur la zone puis appuie sur ta combinaison. Ctrl+Shift+Espace fonctionne toujours.</p>
            </div>

          </div>
        )}

        {/* Chip fichier joint */}
        {attachedFile && (
          <div style={{ padding:"5px 16px", background:"rgba(99,102,241,0.08)", borderBottom:"1px solid rgba(99,102,241,0.2)", display:"flex", alignItems:"center", gap:8 }}>
            <Paperclip size={11} color="#818cf8" />
            <span style={{ fontSize:11, color:"#a5b4fc", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{attachedFile.name}</span>
            <button onClick={() => setAttachedFile(null)} style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.35)", fontSize:13, padding:0, lineHeight:1 }}>✕</button>
          </div>
        )}

        {/* Panneau suggestions fichiers */}
        {fileSuggestions.length > 0 && (
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)", background:"rgba(8,8,18,0.95)" }}>
            <div style={{ padding:"6px 14px 4px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:9, fontWeight:700, color:"rgba(165,180,252,0.5)", textTransform:"uppercase" as const, letterSpacing:"0.08em" }}>
                {fileSuggestions.length} fichier{fileSuggestions.length > 1 ? "s" : ""} trouvé{fileSuggestions.length > 1 ? "s" : ""}
              </span>
              <button onClick={() => setFileSuggestions([])} style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.25)", fontSize:10, padding:"0 4px" }}>✕</button>
            </div>
            {fileSuggestions.map((f, i) => {
              const name = f.split("\\").pop() || f;
              const ext = name.split(".").pop()?.toLowerCase() || "";
              const extColor: Record<string,string> = { exe:"#f87171", pdf:"#fb923c", png:"#34d399", jpg:"#34d399", jpeg:"#34d399", ico:"#a78bfa", svg:"#60a5fa", mp4:"#f472b6", zip:"#fbbf24", docx:"#60a5fa", xlsx:"#34d399", pptx:"#fb923c" };
              const color = extColor[ext] || "rgba(255,255,255,0.4)";
              return (
                <button key={i}
                  onClick={async () => {
                    setFileSuggestions([]);
                    setInput("");
                    // @ts-ignore
                    await window.api?.openPath(f);
                    setMessages(prev => [...prev, { role:"assistant" as const, content:`Ouverture de ${name}` }]);
                  }}
                  style={{ display:"flex", alignItems:"center", gap:10, width:"100%", padding:"8px 14px", background:"transparent", border:"none", cursor:"pointer", textAlign:"left" as const, transition:"background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,0.12)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                  <span style={{ fontSize:9, fontWeight:700, color, background:`${color}18`, borderRadius:4, padding:"2px 5px", flexShrink:0, textTransform:"uppercase" as const, minWidth:28, textAlign:"center" as const }}>
                    {ext || "?"}
                  </span>
                  <span style={{ fontSize:12, color:"rgba(255,255,255,0.8)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{name}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Mode Executive Assistant */}
        {executiveMode && (
          <ExecutivePanel
            tasks={tasks}
            briefing={briefing}
            briefingLoading={briefingLoading}
            setBriefing={setBriefing}
            setBriefingLoading={setBriefingLoading}
            completeTask={completeTask}
            setTasks={setTasks}
            setExecutiveMode={setExecutiveMode}
            setMessages={setMessages}
            setLoading={setLoading}
          />
        )}


        {/* Messages */}
        {messages.length > 0 ? (
          <div style={styles.messages}>
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "ao-msg-user" : "ao-msg-ai"} style={{ marginBottom: 12, display:"flex", flexDirection:"column", alignItems: m.role==="user"?"flex-end":"flex-start" }}
                onMouseEnter={() => setHoveredMsgIdx(i)}
                onMouseLeave={() => setHoveredMsgIdx(null)}>
                {/* Header: name + time */}
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, flexDirection: m.role==="user"?"row-reverse":"row" }}>
                  {m.role==="assistant" && (
                    <div style={{ width:22, height:22, borderRadius:"50%", background:"rgba(99,102,241,0.15)", border:"1px solid rgba(99,102,241,0.3)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                      <Zap size={10} color="#818cf8" />
                    </div>
                  )}
                  <span style={{ fontSize:10, fontWeight:600, color: m.role==="user"?"rgba(199,191,255,0.6)":"rgba(129,140,248,0.7)", letterSpacing:"0.03em" }}>
                    {m.role==="user" ? tr("msg_you") : "Omnyx"}
                  </span>
                  {m.ts && <span style={{ fontSize:9, color:"rgba(255,255,255,0.2)" }}>{m.ts}</span>}
                </div>

                {/* Bubble */}
                <div style={{ maxWidth:"88%", ...(m.role==="user" ? {
                  background: th.userMsg,
                  borderRadius:"16px 4px 16px 16px",
                  padding:"9px 13px",
                  color:"#ede9fe",
                  fontSize:12,
                  lineHeight:1.6,
                  boxShadow:"0 4px 20px rgba(99,102,241,0.25)",
                  whiteSpace:"pre-wrap" as const,
                } : {
                  background:"transparent",
                  padding:"0 4px",
                  color:"#b8b8cc",
                  fontSize:12,
                  lineHeight:1.65,
                  width:"100%",
                  maxWidth:"100%",
                })}}
                  className={m.role==="assistant" && loading && i===messages.length-1 && m.content.length > 0 ? "ao-cursor" : ""}>
                  {m.role==="user" ? (
                    <>
                      {m.content}
                      {m.attachment && (
                        <div style={{ marginTop:6, display:"flex", alignItems:"center", gap:5, opacity:0.75 }}>
                          <Paperclip size={10} />
                          <span style={{ fontSize:10 }}>{m.attachment}</span>
                        </div>
                      )}
                    </>
                  ) : loading && i === messages.length - 1 && m.content.length === 0 ? (
                    <div className="ao-typing-dots"><span /><span /><span /></div>
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                      h1: ({children}) => <p style={{ color:"#e0e0ff", fontWeight:700, fontSize:13, marginBottom:5, marginTop:8, borderBottom:"1px solid rgba(255,255,255,0.08)", paddingBottom:4 }}>{children}</p>,
                      h2: ({children}) => <p style={{ color:"#c8c8f0", fontWeight:700, fontSize:12, marginBottom:4, marginTop:7 }}>{children}</p>,
                      h3: ({children}) => <p style={{ color:"#a5b4fc", fontWeight:600, fontSize:11, marginBottom:3, marginTop:6 }}>{children}</p>,
                      strong: ({children}) => <strong style={{ color:"#ffffff", fontWeight:700 }}>{children}</strong>,
                      em: ({children}) => <em style={{ color:"#c4b5fd" }}>{children}</em>,
                      p: ({children}) => <p style={{ marginBottom:5, lineHeight:1.65 }}>{children}</p>,
                      ul: ({children}) => <ul style={{ margin:"4px 0 6px 0", padding:0, listStyle:"none" }}>{children}</ul>,
                      ol: ({children}) => <ol style={{ paddingLeft:14, marginBottom:6, marginTop:4 }}>{children}</ol>,
                      li: ({children}) => <li style={{ display:"flex", alignItems:"flex-start", gap:6, marginBottom:3, color:"#c4c4d8", lineHeight:1.55 }}>
                        <span style={{ color:"#6366f1", flexShrink:0, marginTop:4, width:4, height:4, borderRadius:"50%", background:"#6366f1", display:"inline-block" }}/>
                        <span>{children}</span>
                      </li>,
                      code: ({children, className}) => className ? (
                        <pre style={{ background:"rgba(0,0,0,0.45)", border:"1px solid rgba(99,102,241,0.2)", borderRadius:8, padding:"8px 10px", margin:"6px 0", overflowX:"auto" }}>
                          <code style={{ color:"#a5f3fc", fontSize:10, fontFamily:"'Courier New',monospace", lineHeight:1.5 }}>{children}</code>
                        </pre>
                      ) : (
                        <code style={{ background:"rgba(99,102,241,0.15)", border:"1px solid rgba(99,102,241,0.2)", borderRadius:4, padding:"1px 5px", color:"#f0abfc", fontSize:10, fontFamily:"'Courier New',monospace" }}>{children}</code>
                      ),
                      blockquote: ({children}) => <blockquote style={{ borderLeft:"2px solid #6366f1", paddingLeft:8, margin:"5px 0", color:"#888", fontStyle:"italic", background:"rgba(99,102,241,0.05)", borderRadius:"0 4px 4px 0" }}>{children}</blockquote>,
                      a: ({children, href}) => <a href={href} style={{ color:"#818cf8", textDecoration:"underline" }}>{children}</a>,
                      hr: () => <hr style={{ border:"none", borderTop:"1px solid rgba(255,255,255,0.07)", margin:"7px 0" }}/>,
                    }}>{m.content}</ReactMarkdown>
                  )}
                </div>

                {/* Boutons copier + épingler */}
                {m.role === "assistant" && (
                  <div style={{ marginTop:6, display:"flex", gap:5 }}>
                    <button
                      title="Copier la réponse"
                      onClick={async () => { await (window.api as any)?.writeClipboard(m.content); setCopiedIdx(i); setTimeout(() => setCopiedIdx(null), 1500); }}
                      className="ao-action-btn"
                      style={{ display:"flex", alignItems:"center", gap:5, background: copiedIdx === i ? "rgba(52,211,153,0.15)" : "rgba(99,102,241,0.12)", border: copiedIdx === i ? "1px solid rgba(52,211,153,0.4)" : "1px solid rgba(99,102,241,0.25)", borderRadius:7, padding:"4px 10px", cursor:"pointer", transition:"all 0.15s", color: copiedIdx === i ? "#34d399" : "rgba(165,180,252,0.8)", fontSize:11, fontFamily:"inherit" }}>
                      <span style={{ fontSize:12 }}>{copiedIdx === i ? "✓" : "⎘"}</span>
                      <span>{copiedIdx === i ? "Copié !" : "Copier"}</span>
                    </button>
                    {(() => {
                      const isPinned = pinnedMessages.some(p => p.content === m.content);
                      return (
                        <button
                          title={isPinned ? "Désépingler" : "Épingler cette réponse"}
                          onClick={() => {
                            const next = isPinned
                              ? pinnedMessages.filter(p => p.content !== m.content)
                              : [...pinnedMessages, { content: m.content, ts: m.ts }];
                            setPinnedMessages(next);
                            try { localStorage.setItem("omnyx_pinned", JSON.stringify(next)); } catch {}
                          }}
                          style={{ display:"flex", alignItems:"center", gap:4, background: isPinned ? "rgba(245,158,11,0.18)" : "rgba(255,255,255,0.05)", border: isPinned ? "1px solid rgba(245,158,11,0.4)" : "1px solid rgba(255,255,255,0.08)", borderRadius:7, padding:"4px 9px", cursor:"pointer", transition:"all 0.15s", color: isPinned ? "#fcd34d" : "rgba(255,255,255,0.3)", fontSize:11, fontFamily:"inherit" }}>
                          <span style={{ fontSize:11 }}>📌</span>
                        </button>
                      );
                    })()}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div style={{ display:"flex", alignItems:"flex-start", gap:8, marginBottom:12 }}>
                <div style={{ width:22, height:22, borderRadius:"50%", background:"rgba(99,102,241,0.15)", border:"1px solid rgba(99,102,241,0.3)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                  <span style={{ fontSize:10, color:"#818cf8" }}>⚡</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:4, padding:"8px 12px", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:"4px 14px 14px 14px" }}>
                  {[0,1,2].map(i => (
                    <span key={i} style={{ width:5, height:5, borderRadius:"50%", background:"#6366f1", animation:`pulse 1.4s ease-in-out ${i*0.25}s infinite`, display:"inline-block" }}/>
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        ) : (
          /* État vide : actions rapides */
          <div style={styles.quickActions}>
            {/* Suggestions proactives — urgences uniquement */}
            {(() => {
              const suggestions = generateSuggestions(tasks, currentContext, messages.length > 0, !!lastPageRef.current)
                .filter(s => !dismissedSuggestions.has(s.id) && s.id === "urgent_tasks");
              if (!suggestions.length) return null;
              return (
                <div style={{ marginBottom: 10 }}>
                  {suggestions.map(s => (
                    <div key={s.id} className="ao-panel" style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", marginBottom: 5, background: "rgba(244,63,94,0.06)", border: "1px solid rgba(244,63,94,0.2)", borderRadius: 10 }}>
                      <span style={{ fontSize: 13, flexShrink: 0 }}>{s.icon}</span>
                      <span style={{ flex: 1, fontSize: 11, color: "#8888aa" }}>{s.label}</span>
                      <button className="no-drag" style={{ background: "rgba(244,63,94,0.15)", border: "1px solid rgba(244,63,94,0.3)", borderRadius: 6, padding: "3px 10px", fontSize: 10, color: "#fca5a5", cursor: "pointer", flexShrink: 0 }}
                        onClick={async () => {
                          setDismissedSuggestions(prev => new Set([...prev, s.id]));
                          setMessages(prev => [...prev, { role: "user" as const, content: s.label }]);
                          setLoading(true);
                          try {
                            if (s.action === "analyze" || s.action === "memory") {
                              // Capture page si pas encore fait
                              let content = lastPageRef.current?.content || "";
                              let url = currentUrl;
                              if (!content) {
                                // @ts-ignore
                                window.api?.hideWindow();
                                await new Promise(r => setTimeout(r, 600));
                                try {
                                  // @ts-ignore
                                  const raw: string = await window.api?.getBrowserUrl() || "{}";
                                  const parsed = JSON.parse(raw);
                                  content = (parsed.content || "").trim();
                                  if (parsed.url && /^https?:\/\//.test(parsed.url)) url = parsed.url;
                                  if (content) lastPageRef.current = { content, url };
                                } catch {}
                                // @ts-ignore
                                window.api?.showWindow();
                              }
                              const data = await analyzeContent(content, s.prompt, url || undefined);
                              setMessages(prev => [...prev, { role: "assistant", content: data.result || "" }]);
                            } else {
                              setMessages(prev => [...prev, { role: "assistant" as const, content: "" }]);
                              let full = "";
                              for await (const ev of sendMessageStream(s.prompt, "executive")) {
                                if (ev.type === "delta") { full += ev.content; setMessages(prev => { const m = [...prev]; m[m.length-1] = { role: "assistant", content: full }; return m; }); }
                                else if (ev.type === "done" && ev.clean_content) { setMessages(prev => { const m = [...prev]; m[m.length-1] = { role: "assistant", content: ev.clean_content }; return m; }); }
                              }
                            }
                          } catch {} finally { setLoading(false); }
                        }}>
                        Oui
                      </button>
                      <button className="no-drag" style={{ background: "none", border: "none", color: "#3a3a5a", cursor: "pointer", fontSize: 12 }}
                        onClick={() => setDismissedSuggestions(prev => new Set([...prev, s.id]))}>✕</button>
                    </div>
                  ))}
                  <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(99,102,241,0.15), transparent)", margin: "6px 0 10px" }} />
                </div>
              );
            })()}

            <p style={styles.quickTitle}>{tr("quick_title")}</p>
            <div style={styles.quickGrid}>
              {QUICK_ACTION_DEFS.map(a => (
                <button key={a.key} style={styles.quickBtn} className="ao-quick-btn"
                  onClick={() => { setInput(tr(a.prefixKey)); inputRef.current?.focus(); }}>
                  <div style={{ width:26, height:26, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, background:`${a.color}18`, border:`1px solid ${a.color}30` }}>
                    <a.icon size={13} color={a.color} />
                  </div>
                  <span style={styles.quickLabel}>{tr(a.key)}</span>
                </button>
              ))}

            </div>
          </div>
        )}

        {/* Panneau messages épinglés */}
        {showPinned && pinnedMessages.length > 0 && (
          <div style={{ borderTop:"1px solid rgba(245,158,11,0.25)", background:"rgba(245,158,11,0.04)", maxHeight:220, display:"flex", flexDirection:"column" as const }}>
            <div style={{ padding:"8px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:"1px solid rgba(245,158,11,0.1)", flexShrink:0 }}>
              <span style={{ fontSize:10, fontWeight:700, color:"rgba(252,211,77,0.75)", textTransform:"uppercase" as const, letterSpacing:"0.08em" }}>
                📌 {pinnedMessages.length} épinglé{pinnedMessages.length > 1 ? "s" : ""}
              </span>
              <button className="no-drag" onClick={() => setShowPinned(false)}
                style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.25)", fontSize:13, padding:"0 2px" }}>✕</button>
            </div>
            <div style={{ overflowY:"auto" as const, flex:1 }}>
              {pinnedMessages.map((p, idx) => (
                <div key={idx} style={{ padding:"8px 14px", borderBottom:"1px solid rgba(255,255,255,0.04)", display:"flex", gap:8, alignItems:"flex-start" }}>
                  <div style={{ flex:1, overflow:"hidden" }}>
                    {p.ts && <span style={{ fontSize:9, color:"rgba(255,255,255,0.2)", display:"block", marginBottom:2 }}>{p.ts}</span>}
                    <p style={{ fontSize:11, color:"rgba(255,255,255,0.65)", margin:0, lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:3, WebkitBoxOrient:"vertical" as any }}>{p.content}</p>
                  </div>
                  <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                    <button className="no-drag"
                      onClick={async () => { await (window.api as any)?.writeClipboard(p.content); }}
                      title="Copier"
                      style={{ background:"rgba(99,102,241,0.15)", border:"1px solid rgba(99,102,241,0.25)", borderRadius:6, padding:"3px 8px", fontSize:11, color:"rgba(165,180,252,0.8)", cursor:"pointer" }}>
                      ⎘
                    </button>
                    <button className="no-drag"
                      onClick={() => {
                        const next = pinnedMessages.filter((_, j) => j !== idx);
                        setPinnedMessages(next);
                        try { localStorage.setItem("omnyx_pinned", JSON.stringify(next)); } catch {}
                      }}
                      title="Désépingler"
                      style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.25)", fontSize:13, padding:"3px 4px" }}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Panneau historique + recherche */}
        {historyOpen && (
          <div className="ao-panel" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column" as const, maxHeight: 260 }}>
            {/* Barre de recherche */}
            <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <input
                className="no-drag"
                autoFocus
                type="text"
                placeholder={tr("search_placeholder")}
                value={searchQuery}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 8, padding: "5px 10px", color: "white", fontSize: 11, outline: "none", fontFamily: "inherit" }}
                onChange={async (e) => {
                  const q = e.target.value;
                  setSearchQuery(q);
                  if (q.length >= 2) {
                    setSearchLoading(true);
                    try {
                      const results = await searchConversations(q);
                      setSearchResults(results);
                    } catch { setSearchResults([]); }
                    finally { setSearchLoading(false); }
                  } else {
                    setSearchResults([]);
                  }
                }}
              />
            </div>
            {/* Résultats de recherche */}
            <div style={{ overflowY: "auto" as const, flex: 1 }}>
              {searchLoading && <p style={{ color: "#555", fontSize: 11, padding: "8px 14px" }}>{tr("searching")}</p>}
              {!searchLoading && searchQuery.length >= 2 && searchResults.length === 0 && (
                <p style={{ color: "#555", fontSize: 11, padding: "8px 14px" }}>{tr("no_results")} "{searchQuery}"</p>
              )}
              {searchResults.length > 0 ? searchResults.map(r => (
                <button key={r.message_id} className="no-drag"
                  style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid rgba(255,255,255,0.04)", padding: "8px 14px", cursor: "pointer", textAlign: "left" as const }}>
                  <div onClick={async () => {
                    setHistoryOpen(false); setSearchQuery(""); setSearchResults([]);
                    try {
                      const msgs = await getConversationMessages(r.conversation_id);
                      setMessages(msgs.map(m => ({ role: m.role, content: m.content, ts: m.created_at ? new Date(m.created_at).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}) : undefined })));
                      setActiveConversationId(r.conversation_id);
                    } catch {}
                  }}>
                    <p style={{ color: "#aaa", fontSize: 11, fontWeight: 600, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.conversation_title || "Conversation"}</p>
                    <p style={{ color: "#555", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.excerpt}</p>
                  </div>
                </button>
              )) : !searchLoading && conversations.map(conv => (
                <button key={conv.id} className="no-drag"
                  style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid rgba(255,255,255,0.04)", padding: "9px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}
                  onClick={async () => {
                    setHistoryOpen(false);
                    try {
                      const msgs = await getConversationMessages(conv.id);
                      setMessages(msgs.map(m => ({ role: m.role, content: m.content, ts: m.created_at ? new Date(m.created_at).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}) : undefined })));
                      setActiveConversationId(conv.id);
                    } catch {}
                  }}>
                  <span style={{ color: "#ccc", fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{conv.title || "Conversation"}</span>
                  <span style={{ color: "#444", fontSize: 10, flexShrink: 0 }}>{new Date(conv.updated_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span>
                </button>
              ))}
            </div>
          </div>
        )}


        {/* Sélecteur de priorité de tâche */}
        {pendingTask && (
          <div className="ao-panel" style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(99,102,241,0.06)" }}>
            <p style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>{tr("priority_for")} <strong style={{ color: "#ccc" }}>{pendingTask.slice(0, 50)}</strong></p>
            <div style={{ display: "flex", gap: 6 }}>
              {([
                { labelKey: "priority_urgent", value: "urgent" },
                { labelKey: "priority_high",   value: "high"   },
                { labelKey: "priority_medium", value: "medium" },
                { labelKey: "priority_low",    value: "low"    },
              ] as { labelKey: string; value: Task["priority"] }[]).map(p => (
                <button
                  key={p.value}
                  className="no-drag"
                  style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#ddd", fontSize: 11, cursor: "pointer", padding: "6px 4px" }}
                  onClick={async () => {
                    const title = pendingTask;
                    setPendingTask(null);
                    try {
                      await createTask(title, p.value);
                      await loadTasks();
                      if (p.value === "urgent" || p.value === "high") {
                        // @ts-ignore
                        window.api?.notify("⚡ Tâche créée — Omnyx", title);
                      }
                      setMessages(prev => [...prev, { role: "assistant" as const, content: `✅ Tâche créée : "${title}" — ${tr(p.labelKey as any)}` }]);
                      setPendingReminder(title);
                    } catch (e: unknown) {
                      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || "Erreur inconnue";
                      setMessages(prev => [...prev, { role: "assistant" as const, content: `Erreur : ${msg}` }]);
                    }
                  }}
                >
                  {tr(p.labelKey as any)}
                </button>
              ))}
              <button className="no-drag" style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 13, padding: "0 4px" }} onClick={() => setPendingTask(null)}>✕</button>
            </div>
          </div>
        )}


        {/* Confirmation événement calendrier */}
        {pendingEvent && (
          <div className="ao-panel" style={{ padding: "10px 16px", borderTop: "1px solid rgba(236,72,153,0.25)", background: "rgba(236,72,153,0.05)" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
              <span style={{ fontSize:10, fontWeight:700, color:"rgba(249,168,212,0.9)", textTransform:"uppercase" as const, letterSpacing:"0.08em" }}>📅 Événement à confirmer</span>
              <button className="no-drag" onClick={() => setPendingEvent(null)} style={{ background:"none", border:"none", cursor:"pointer", color:"#555", fontSize:13, padding:"0 2px" }}>✕</button>
            </div>
            <p style={{ fontSize:12, fontWeight:600, color:"#f9a8d4", marginBottom:3 }}>{pendingEvent.title}</p>
            <p style={{ fontSize:11, color:"rgba(255,255,255,0.45)", marginBottom:2 }}>
              {pendingEvent.start ? new Date(pendingEvent.start).toLocaleString("fr-FR", { weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }) : ""}
              {pendingEvent.end ? ` → ${new Date(pendingEvent.end).toLocaleString("fr-FR", { hour:"2-digit", minute:"2-digit" })}` : ""}
            </p>
            {pendingEvent.location ? <p style={{ fontSize:11, color:"rgba(255,255,255,0.35)", marginBottom:6 }}>📍 {pendingEvent.location}</p> : <div style={{ marginBottom:8 }} />}
            <div style={{ display:"flex", gap:6 }}>
              <button className="no-drag" style={{ flex:1, background:"rgba(236,72,153,0.2)", border:"1px solid rgba(236,72,153,0.4)", borderRadius:8, color:"#f9a8d4", fontSize:11, cursor:"pointer", padding:"6px 4px" }}
                onClick={async () => {
                  const ev = pendingEvent;
                  setPendingEvent(null);
                  try {
                    await approveAction(ev.id, true);
                    setMessages(prev => [...prev, { role:"assistant" as const, content:`✅ Événement ajouté au calendrier : **${ev.title}**` }]);
                  } catch {
                    setMessages(prev => [...prev, { role:"assistant" as const, content:"Erreur lors de l'ajout au calendrier." }]);
                  }
                }}>
                ✅ Confirmer
              </button>
              <button className="no-drag" style={{ flex:1, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, color:"#888", fontSize:11, cursor:"pointer", padding:"6px 4px" }}
                onClick={async () => {
                  const ev = pendingEvent;
                  setPendingEvent(null);
                  try { await approveAction(ev.id, false); } catch {}
                }}>
                ✕ Annuler
              </button>
            </div>
          </div>
        )}

        {/* Sélecteur de rappel — étape 1 : quand ? */}
        {pendingReminder && !reminderDelay && (
          <div className="ao-panel" style={{ padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(14,14,26,0.9)" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
              <p style={{ fontSize:11, color:"#a5b4fc", fontWeight:600 }}>⏰ Dans combien de temps ?</p>
              <button className="no-drag" onClick={() => setPendingReminder(null)}
                style={{ background:"none", border:"none", cursor:"pointer", color:"#444", fontSize:12 }}>✕</button>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap" as const, gap:5 }}>
              {([
                { label:"15 min",   ms: 15*60*1000 },
                { label:"30 min",   ms: 30*60*1000 },
                { label:"1 heure",  ms: 60*60*1000 },
                { label:"3 heures", ms: 3*60*60*1000 },
                { label:"Demain",   ms: 24*60*60*1000 },
              ]).map(opt => (
                <button key={opt.label} className="no-drag"
                  onClick={() => setReminderDelay(opt)}
                  style={{ background:"rgba(99,102,241,0.12)", border:"1px solid rgba(99,102,241,0.3)", borderRadius:8, color:"#a5b4fc", fontSize:11, cursor:"pointer", padding:"5px 12px" }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sélecteur de rappel — étape 2 : fréquence ? */}
        {pendingReminder && reminderDelay && (
          <div className="ao-panel" style={{ padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(14,14,26,0.9)" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
              <p style={{ fontSize:11, color:"#a5b4fc", fontWeight:600 }}>🔁 Fréquence — <span style={{ color:"#6b6b8a" }}>dans {reminderDelay.label}</span></p>
              <button className="no-drag" onClick={() => setReminderDelay(null)}
                style={{ background:"none", border:"none", cursor:"pointer", color:"#555", fontSize:11 }}>← Retour</button>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap" as const, gap:5 }}>
              {([
                { label:"Une seule fois",    repeatMs: 0 },
                { label:"Toutes les heures", repeatMs: 60*60*1000 },
                { label:"Tous les jours",    repeatMs: 24*60*60*1000 },
                { label:"Toutes les semaines", repeatMs: 7*24*60*60*1000 },
              ]).map(opt => (
                <button key={opt.label} className="no-drag"
                  onClick={() => {
                    const title = pendingReminder!;
                    const delay = reminderDelay!;
                    setPendingReminder(null);
                    setReminderDelay(null);
                    // @ts-ignore
                    window.api?.scheduleReminder(title, delay.ms, opt.repeatMs || undefined);
                    const freqLabel = opt.repeatMs ? ` · ${opt.label.toLowerCase()}` : "";
                    setMessages(prev => [...prev, { role:"assistant" as const, content:`⏰ Rappel dans ${delay.label}${freqLabel} — "${title}"` }]);
                  }}
                  style={{ background:"rgba(99,102,241,0.12)", border:"1px solid rgba(99,102,241,0.3)", borderRadius:8, color:"#a5b4fc", fontSize:11, cursor:"pointer", padding:"5px 12px" }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Panneau Écris pour moi */}
        {writeForMeMode && (
          <div style={{ padding:"10px 16px", borderTop:"1px solid rgba(99,102,241,0.2)", background:"rgba(99,102,241,0.04)", maxHeight:280, overflowY:"auto" as const }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <PenLine size={11} color="#a5b4fc" />
                <span style={{ fontSize:10, fontWeight:700, color:"rgba(165,180,252,0.8)", textTransform:"uppercase" as const, letterSpacing:"0.08em" }}>Écris pour moi</span>
              </div>
              <button className="no-drag" onClick={() => { setWriteForMeMode(false); setWriteForMeResult(""); setWriteForMePrompt(""); setWriteForMeAttach(null); }} style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.25)", fontSize:12 }}>✕</button>
            </div>
            {/* Sélecteur format */}
            <div style={{ display:"flex", gap:4, marginBottom:6 }}>
              {["email","message","post","rapport","autre"].map(f => (
                <button key={f} className="no-drag" onClick={() => { setWriteFormat(f); if (f !== "email") setWriteForMeAttach(null); }}
                  style={{ fontSize:10, padding:"3px 8px", borderRadius:6, border: writeFormat===f ? "1px solid rgba(99,102,241,0.6)" : "1px solid rgba(255,255,255,0.08)", background: writeFormat===f ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.04)", color: writeFormat===f ? "#a5b4fc" : "rgba(255,255,255,0.4)", cursor:"pointer", textTransform:"capitalize" as const }}>
                  {f}
                </button>
              ))}
            </div>
            {/* Sélecteur ton */}
            <div style={{ display:"flex", gap:4, marginBottom:8 }}>
              {[{k:"professionnel",l:"Pro"},{k:"decontracte",l:"Décontracté"},{k:"creatif",l:"Créatif"},{k:"persuasif",l:"Persuasif"}].map(t => (
                <button key={t.k} className="no-drag" onClick={() => setWriteTone(t.k)}
                  style={{ fontSize:10, padding:"3px 8px", borderRadius:6, border: writeTone===t.k ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.08)", background: writeTone===t.k ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.04)", color: writeTone===t.k ? "#c4b5fd" : "rgba(255,255,255,0.4)", cursor:"pointer" }}>
                  {t.l}
                </button>
              ))}
            </div>
            {/* Pièce jointe — visible uniquement pour email */}
            {writeFormat === "email" && (
              <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:6 }}>
                <button className="no-drag"
                  onClick={() => {
                    // @ts-ignore
                    window.api?.lockWindow();
                    writeForMeFileRef.current?.click();
                    const onFocus = () => setTimeout(() => { /* @ts-ignore */ window.api?.unlockWindow(); }, 300);
                    window.addEventListener("focus", onFocus, { once: true });
                  }}
                  style={{ display:"flex", alignItems:"center", gap:5, fontSize:10, padding:"3px 9px", borderRadius:6, border: writeForMeAttach ? "1px solid rgba(99,102,241,0.5)" : "1px solid rgba(255,255,255,0.1)", background: writeForMeAttach ? "rgba(99,102,241,0.18)" : "rgba(255,255,255,0.04)", color: writeForMeAttach ? "#a5b4fc" : "rgba(255,255,255,0.4)", cursor:"pointer", flexShrink:0 }}>
                  <Paperclip size={10} />
                  {writeForMeAttach ? writeForMeAttach.name : "Joindre un fichier"}
                </button>
                {writeForMeAttach && (
                  <button className="no-drag" onClick={() => setWriteForMeAttach(null)}
                    style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.3)", fontSize:12, padding:0, lineHeight:1 }}>✕</button>
                )}
                <input ref={writeForMeFileRef} type="file" style={{ display:"none" }}
                  accept=".pdf,.txt,.md,.csv,.json,.docx,.doc,.html,.rtf"
                  onChange={async (e) => {
                    // @ts-ignore
                    window.api?.unlockWindow();
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const data = await uploadFile(file);
                      if (data.content) setWriteForMeAttach({ name: data.name, content: data.content });
                    } catch {}
                    finally { if (writeForMeFileRef.current) writeForMeFileRef.current.value = ""; }
                  }}
                />
              </div>
            )}
            {/* Input description */}
            <div style={{ display:"flex", gap:6, marginBottom: writeForMeResult ? 8 : 0 }}>
              <input className="no-drag" value={writeForMePrompt} onChange={e => setWriteForMePrompt(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") generateWriteForMe(); }}
                placeholder={`Décris ton ${writeFormat}…`}
                style={{ flex:1, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(99,102,241,0.3)", borderRadius:8, padding:"7px 10px", color:"white", fontSize:12, outline:"none", fontFamily:"inherit" }} />
              <button className="no-drag" onClick={generateWriteForMe} disabled={writeForMeLoading || !writeForMePrompt.trim()}
                style={{ background:"linear-gradient(135deg,#6366f1,#8b5cf6)", border:"none", borderRadius:8, color:"white", fontSize:11, cursor: writeForMeLoading ? "wait" : "pointer", padding:"0 14px", opacity: writeForMeLoading ? 0.7 : 1, flexShrink:0 }}>
                {writeForMeLoading ? "…" : "Générer"}
              </button>
            </div>
            {/* Résultat */}
            {writeForMeResult && (
              <div className="ao-panel" style={{ marginTop:10, background:"linear-gradient(135deg, rgba(99,102,241,0.09), rgba(139,92,246,0.05))", border:"1px solid rgba(99,102,241,0.2)", borderRadius:10, padding:10 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:7 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <Sparkles size={11} color="#a5b4fc" />
                    <span style={{ fontSize:9, fontWeight:700, color:"rgba(165,180,252,0.7)", textTransform:"uppercase" as const, letterSpacing:"0.08em" }}>
                      Résultat — modifiable
                    </span>
                  </div>
                  <span style={{ fontSize:10, color:"rgba(255,255,255,0.3)" }}>{writeForMeResult.length} caractères</span>
                </div>
                <textarea
                  className="no-drag"
                  value={writeForMeResult}
                  onChange={e => setWriteForMeResult(e.target.value)}
                  spellCheck={false}
                  style={{
                    width:"100%", boxSizing:"border-box" as const, display:"block",
                    background:"rgba(0,0,0,0.35)", border:"1px solid rgba(99,102,241,0.2)",
                    borderRadius:8, padding:"10px 12px", color:"#e4e4ed", fontSize:12,
                    lineHeight:1.7, fontFamily:"inherit", whiteSpace:"pre-wrap" as const,
                    resize:"vertical" as const, minHeight:80, maxHeight:200, outline:"none",
                    boxShadow:"inset 0 1px 4px rgba(0,0,0,0.3)",
                  }}
                />
                <button className="no-drag" onClick={() => {
                    navigator.clipboard.writeText(writeForMeResult);
                    setWriteForMeCopied(true);
                    setTimeout(() => setWriteForMeCopied(false), 1500);
                  }}
                  style={{ width:"100%", marginTop:8, display:"flex", alignItems:"center", justifyContent:"center", gap:6, background: writeForMeCopied ? "rgba(16,185,129,0.18)" : "linear-gradient(135deg,#6366f1,#8b5cf6)", border: writeForMeCopied ? "1px solid rgba(16,185,129,0.4)" : "none", borderRadius:7, color: writeForMeCopied ? "#6ee7b7" : "white", fontSize:11, fontWeight:600, cursor:"pointer", padding:"7px 0", transition:"background 0.15s, color 0.15s" }}>
                  {writeForMeCopied ? <Check size={13} /> : <Copy size={13} />}
                  {writeForMeCopied ? "Copié dans le presse-papiers" : "Copier"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Panneau mémorisation rapide */}
        {quickMemoryMode && (
          <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column" as const, gap: 8, background: "rgba(245,158,11,0.04)" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:10, fontWeight:700, color:"rgba(252,211,77,0.7)", textTransform:"uppercase" as const, letterSpacing:"0.08em" }}>
                Mémoriser
              </span>
              <button className="no-drag" onClick={() => setQuickMemoryMode(false)}
                style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.25)", fontSize:12, padding:"0 2px" }}>✕</button>
            </div>
            <textarea
              className="no-drag"
              autoFocus
              placeholder="Ce que tu veux retenir..."
              style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(245,158,11,0.3)", borderRadius:8, padding:"8px 12px", color:"white", fontSize:12, outline:"none", resize:"none" as const, height:70, fontFamily:"inherit" }}
              onKeyDown={async (e) => {
                if (e.key === "Escape") { setQuickMemoryMode(false); return; }
                if (e.key === "Enter" && e.ctrlKey) {
                  const text = (e.target as HTMLTextAreaElement).value.trim();
                  if (!text) return;
                  setQuickMemoryMode(false);
                  try {
                    await api.post("/api/memory/", { content: text, memory_type: "long_term" });
                    setMessages(prev => [...prev, { role:"assistant" as const, content:`⭐ Mémorisé : "${text.slice(0,80)}"`, ts: now() }]);
                  } catch {
                    setMessages(prev => [...prev, { role:"assistant" as const, content:"Erreur lors de la mémorisation.", ts: now() }]);
                  }
                }
              }}
            />
            <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
              <button className="no-drag" style={{ fontSize:11, color:"#555", background:"none", border:"none", cursor:"pointer" }} onClick={() => setQuickMemoryMode(false)}>Annuler</button>
              <button className="no-drag"
                style={{ background:"linear-gradient(135deg,#d97706,#b45309)", border:"none", borderRadius:6, color:"white", fontSize:11, cursor:"pointer", padding:"4px 14px" }}
                onClick={async (e) => {
                  const ta = (e.currentTarget.closest("div")?.previousSibling as HTMLTextAreaElement);
                  const text = ta?.value?.trim() || "";
                  if (!text) return;
                  setQuickMemoryMode(false);
                  try {
                    await api.post("/api/memory/", { content: text, memory_type: "long_term" });
                    setMessages(prev => [...prev, { role:"assistant" as const, content:`⭐ Mémorisé : "${text.slice(0,80)}"`, ts: now() }]);
                  } catch {
                    setMessages(prev => [...prev, { role:"assistant" as const, content:"Erreur lors de la mémorisation.", ts: now() }]);
                  }
                }}>
                Mémoriser
              </button>
            </div>
          </div>
        )}

        {/* Panneau coller-analyser */}
        {pasteMode && (
          <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column" as const, gap: 8 }}>
            <textarea
              className="no-drag"
              autoFocus
              placeholder={tr("paste_placeholder")}
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, padding: "8px 12px", color: "white", fontSize: 12, outline: "none", resize: "none" as const, height: 80, fontFamily: "inherit" }}
              onKeyDown={async (e) => {
                if (e.key === "Escape") setPasteMode(false);
                if (e.key === "Enter" && e.ctrlKey) {
                  const text = (e.target as HTMLTextAreaElement).value.trim();
                  if (!text) return;
                  setPasteMode(false);
                  setMessages(prev => [...prev, { role: "user" as const, content: tr("analyze_paste") }]);
                  setLoading(true);
                  lastPageRef.current = { content: text, url: "" };
                  try {
                    const data = await analyzeContent(text, "Analyse et résume ce texte de façon claire et structurée.");
                    setMessages(prev => [...prev, { role: "assistant", content: data.result || "" }]);
                  } catch { setMessages(prev => [...prev, { role: "assistant", content: "Erreur de connexion." }]); }
                  finally { setLoading(false); }
                }
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="no-drag" style={{ fontSize: 11, color: "#555", background: "none", border: "none", cursor: "pointer" }} onClick={() => setPasteMode(false)}>{tr("cancel")}</button>
              <button
                className="no-drag"
                style={{ background: "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", borderRadius: 6, color: "white", fontSize: 11, cursor: "pointer", padding: "4px 14px" }}
                onClick={async (e) => {
                  const ta = (e.currentTarget.closest("div")?.previousSibling as HTMLTextAreaElement);
                  const text = ta?.value?.trim() || "";
                  if (!text) return;
                  setPasteMode(false);
                  setMessages(prev => [...prev, { role: "user" as const, content: tr("analyze_paste") }]);
                  setLoading(true);
                  lastPageRef.current = { content: text, url: "" };
                  try {
                    const data = await analyzeContent(text, "Analyse et résume ce texte de façon claire et structurée.");
                    setMessages(prev => [...prev, { role: "assistant", content: data.result || "" }]);
                  } catch { setMessages(prev => [...prev, { role: "assistant", content: "Erreur de connexion." }]); }
                  finally { setLoading(false); }
                }}
              >{tr("analyze")}</button>
            </div>
          </div>
        )}

        {/* Panneau de saisie URL pour analyser une page */}
        {analyseUrl === "prompt" && (
          <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="no-drag"
              autoFocus
              type="text"
              placeholder={tr("url_placeholder")}
              style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, padding: "7px 12px", color: "white", fontSize: 12, outline: "none" }}
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const url = (e.target as HTMLInputElement).value.trim();
                  if (!url) return;
                  setAnalyseUrl("");
                  setLoading(true);
                  setMessages(prev => [...prev, { role: "user", content: `${tr("analyze_msg")} : ${url}` }]);
                  try {
                    const data = await sendMessage(`Analyse et résume cette page en détail : ${url}`, "research");
                    setMessages(prev => [...prev, { role: "assistant", content: data.message?.content || data.clean_content || "" }]);
                  } catch { setMessages(prev => [...prev, { role: "assistant", content: "Erreur de connexion." }]); }
                  finally { setLoading(false); }
                }
                if (e.key === "Escape") setAnalyseUrl("");
              }}
            />
            <button style={{ fontSize: 11, color: "#666", background: "none", border: "none", cursor: "pointer" }} onClick={() => setAnalyseUrl("")}>✕</button>
          </div>
        )}

        {/* Résultats de fichiers cliquables */}
        {fileResults.length > 0 && (
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)", background:"rgba(8,8,18,0.8)", maxHeight:180, overflowY:"auto" as const }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 14px 4px" }}>
              <span style={{ fontSize:10, fontWeight:700, color:"rgba(165,180,252,0.7)", textTransform:"uppercase" as const, letterSpacing:"0.08em" }}>
                {fileResults.length} fichier{fileResults.length > 1 ? "s" : ""}
              </span>
              <button onClick={() => setFileResults([])} style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.3)", fontSize:11, padding:"2px 6px" }}>✕</button>
            </div>
            {fileResults.map((f, i) => {
              const name = f.split("\\").pop() || f;
              const ext = name.split(".").pop()?.toLowerCase() || "";
              const extColor: Record<string, string> = { exe:"#f87171", pdf:"#fb923c", png:"#34d399", jpg:"#34d399", jpeg:"#34d399", ico:"#a78bfa", svg:"#60a5fa", mp4:"#f472b6", zip:"#fbbf24" };
              const color = extColor[ext] || "rgba(255,255,255,0.5)";
              return (
                <button key={i} onClick={async () => { /* @ts-ignore */ await window.api?.openPath(f); }}
                  style={{ display:"flex", alignItems:"center", gap:10, width:"100%", padding:"7px 14px", background:"transparent", border:"none", cursor:"pointer", textAlign:"left" as const, transition:"background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,0.1)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                  <span style={{ fontSize:10, fontWeight:700, color, background:`${color}20`, borderRadius:4, padding:"1px 5px", flexShrink:0, textTransform:"uppercase" as const }}>
                    {ext || "?"}
                  </span>
                  <span style={{ fontSize:11, color:"rgba(255,255,255,0.75)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{name}</span>
                </button>
              );
            })}
          </div>
        )}

        </>}

        {/* Panneau Timer */}
        {timerOpen && (() => {
          const R = 52;
          const circ = 2 * Math.PI * R;
          const progress = timerTotal > 0 ? timerSeconds / timerTotal : 1;
          const offset = circ * (1 - progress);
          const done = timerSeconds === 0;
          const ringColor = done ? "#34d399" : "#f97316";
          const glowColor = done ? "rgba(52,211,153,0.5)" : "rgba(249,115,22,0.5)";
          return (
            <div style={{ padding:"14px 20px 16px", borderTop:"1px solid rgba(251,146,60,0.12)", background:"linear-gradient(180deg,rgba(249,115,22,0.05) 0%,transparent 100%)", display:"flex", flexDirection:"column" as const, gap:12 }}>
              {/* Header */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span style={{ fontSize:10, fontWeight:700, color:"rgba(249,115,22,0.5)", textTransform:"uppercase" as const, letterSpacing:"0.12em" }}>Timer</span>
                <button className="no-drag" onClick={() => setTimerOpen(false)} style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.2)", fontSize:13, padding:0, lineHeight:1 }}>✕</button>
              </div>

              {/* Cercle centré avec temps à l'intérieur */}
              <div style={{ display:"flex", flexDirection:"column" as const, alignItems:"center", gap:14 }}>
                <div style={{ position:"relative" as const, width:130, height:130 }}>
                  <svg width="130" height="130" viewBox="0 0 130 130" style={{ transform:"rotate(-90deg)", position:"absolute" as const, inset:0 }}>
                    <defs>
                      <linearGradient id="timerArcGrad" x1="65" y1="13" x2="65" y2="117" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stopColor="#fbbf24"/>
                        <stop offset="100%" stopColor="#f97316"/>
                      </linearGradient>
                    </defs>
                    {/* Piste de fond */}
                    <circle cx="65" cy="65" r={R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="11"/>
                    {/* Arc de progression */}
                    <circle cx="65" cy="65" r={R} fill="none"
                      stroke={done ? "#34d399" : "url(#timerArcGrad)"}
                      strokeWidth="11" strokeLinecap="round"
                      strokeDasharray={circ} strokeDashoffset={offset}
                      style={{ transition: timerRunning ? "stroke-dashoffset 1s linear" : "stroke-dashoffset 0.3s ease", filter:`drop-shadow(0 0 10px ${glowColor})` }}
                    />
                  </svg>
                  {/* Temps centré à l'intérieur */}
                  <div style={{ position:"absolute" as const, inset:0, display:"flex", flexDirection:"column" as const, alignItems:"center", justifyContent:"center", pointerEvents:"none" }}>
                    {done ? (
                      <span style={{ fontSize:34, color:"#34d399", lineHeight:1 }}>✓</span>
                    ) : (
                      <>
                        <span style={{ fontSize:26, fontWeight:700, color:"#fb923c", fontFamily:"'Courier New',monospace", letterSpacing:"0.05em", lineHeight:1 }}>
                          {timerFmt(timerSeconds)}
                        </span>
                        <span style={{ fontSize:9, color:"rgba(255,255,255,0.22)", marginTop:5, letterSpacing:"0.1em", textTransform:"uppercase" as const }}>
                          {timerLabel}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Sélecteur min : sec (seulement à l'arrêt) */}
                {!timerRunning && !done && (() => {
                  const mins = Math.floor(timerSeconds / 60);
                  const secs = timerSeconds % 60;
                  const btnStyle = { width:26, height:20, borderRadius:5, background:"rgba(249,115,22,0.1)", border:"1px solid rgba(249,115,22,0.2)", color:"#fb923c", fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" as const, userSelect:"none" as const };
                  const digStyle = { fontSize:22, fontWeight:700, color:"#fb923c", fontFamily:"'Courier New',monospace", lineHeight:1, width:38, textAlign:"center" as const };
                  const labelStyle = { fontSize:8, color:"rgba(255,255,255,0.2)", letterSpacing:"0.08em", marginTop:2 };
                  return (
                    <div style={{ display:"flex", alignItems:"flex-end", gap:4 }}>
                      {/* Minutes */}
                      <div style={{ display:"flex", flexDirection:"column" as const, alignItems:"center", gap:3 }}>
                        <button className="no-drag" style={btnStyle}
                          onClick={() => { const s=Math.min(5999,timerSeconds+60); setTimerSeconds(s); setTimerTotal(s); setTimerLabel(timerFmt(s)); }}>▲</button>
                        <span style={digStyle}>{String(mins).padStart(2,"0")}</span>
                        <button className="no-drag" style={btnStyle}
                          onClick={() => { const s=Math.max(secs||5,timerSeconds-60); setTimerSeconds(s); setTimerTotal(s); setTimerLabel(timerFmt(s)); }}>▼</button>
                        <span style={labelStyle}>min</span>
                      </div>
                      <span style={{ fontSize:22, fontWeight:700, color:"rgba(251,146,60,0.6)", fontFamily:"'Courier New',monospace", marginBottom:16, lineHeight:1 }}>:</span>
                      {/* Secondes */}
                      <div style={{ display:"flex", flexDirection:"column" as const, alignItems:"center", gap:3 }}>
                        <button className="no-drag" style={btnStyle}
                          onClick={() => { const s=Math.min(5999,timerSeconds+5); setTimerSeconds(s); setTimerTotal(s); setTimerLabel(timerFmt(s)); }}>▲</button>
                        <span style={digStyle}>{String(secs).padStart(2,"0")}</span>
                        <button className="no-drag" style={btnStyle}
                          onClick={() => { const s=Math.max(mins>0?0:5,timerSeconds-5); setTimerSeconds(s); setTimerTotal(s); setTimerLabel(timerFmt(s)); }}>▼</button>
                        <span style={labelStyle}>sec</span>
                      </div>
                    </div>
                  );
                })()}

                {/* Reset + Play/Pause */}
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <button className="no-drag"
                    onClick={() => { setTimerRunning(false); setTimerSeconds(timerTotal > 0 ? timerTotal : 25*60); }}
                    style={{ width:34, height:34, borderRadius:"50%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", cursor:"pointer", color:"rgba(255,255,255,0.4)", fontSize:15, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    ↺
                  </button>
                  <button className="no-drag"
                    onClick={() => {
                      if (done) {
                        setTimerSeconds(timerTotal);
                        setTimeout(() => setTimerRunning(true), 0);
                      } else {
                        if (!timerRunning) setTimerTotal(timerSeconds);
                        setTimerRunning(v => !v);
                      }
                    }}
                    style={{ width:52, height:52, borderRadius:"50%", background:"linear-gradient(135deg,#f97316,#fb923c)", border:"none", boxShadow:`0 0 22px ${glowColor}, 0 2px 8px rgba(0,0,0,0.4)`, cursor:"pointer", color:"white", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center", transition:"box-shadow 0.2s" }}>
                    {timerRunning ? "⏸" : "▶"}
                  </button>
                </div>
              </div>

              {/* Presets */}
              <div style={{ display:"flex", gap:4, justifyContent:"center", flexWrap:"wrap" as const }}>
                {([
                  { label:"5min", s:5*60 }, { label:"15min", s:15*60 }, { label:"25min", s:25*60 },
                  { label:"30min", s:30*60 }, { label:"1h", s:60*60 },
                ]).map(p => {
                  const active = timerSeconds === p.s && !timerRunning;
                  return (
                    <button key={p.label} className="no-drag"
                      onClick={() => { setTimerRunning(false); setTimerSeconds(p.s); setTimerTotal(p.s); setTimerLabel(p.label); }}
                      style={{ fontSize:10, padding:"3px 10px", borderRadius:20, border: active ? "1px solid rgba(249,115,22,0.55)" : "1px solid rgba(255,255,255,0.07)", background: active ? "rgba(249,115,22,0.15)" : "rgba(255,255,255,0.03)", color: active ? "#fb923c" : "rgba(255,255,255,0.35)", cursor:"pointer", transition:"all 0.15s", fontWeight: active ? 600 : 400 }}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Pied de page — masqué en compact */}
        {!compactMode && <div style={styles.footer}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={styles.footerHint}>{tr("footer_hint")}</span>
            {timerRunning && (
              <button className="no-drag" onClick={() => setTimerOpen(v => !v)}
                style={{ display:"flex", alignItems:"center", gap:4, background:"rgba(251,146,60,0.12)", border:"1px solid rgba(251,146,60,0.3)", borderRadius:6, padding:"2px 8px", cursor:"pointer", animation:"pulse 2s ease-in-out infinite" }}>
                <span style={{ fontSize:10 }}>⏱</span>
                <span style={{ fontSize:10, fontWeight:700, color:"#fb923c", fontFamily:"'Courier New',monospace" }}>{timerFmt(timerSeconds)}</span>
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Épinglés */}
            {pinnedMessages.length > 0 && (
              <button title="" className="no-drag ao-icon-btn"
                onMouseEnter={e => showTip(e, `${pinnedMessages.length} message${pinnedMessages.length > 1 ? "s" : ""} épinglé${pinnedMessages.length > 1 ? "s" : ""}`)} onMouseLeave={hideTip}
                onClick={() => setShowPinned(v => !v)}
                style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:4, height:28, borderRadius:8, cursor:"pointer", border: showPinned ? "1px solid rgba(245,158,11,0.5)" : "1px solid rgba(245,158,11,0.2)", background: showPinned ? "rgba(245,158,11,0.18)" : "rgba(245,158,11,0.06)", flexShrink:0, padding:"0 8px" }}>
                <span style={{ fontSize:11 }}>📌</span>
                <span style={{ fontSize:10, fontWeight:700, color: showPinned ? "#fcd34d" : "rgba(252,211,77,0.5)" }}>{pinnedMessages.length}</span>
              </button>
            )}
            {/* Exporter */}
            {messages.length > 0 && (
              <button title="" className="no-drag ao-icon-btn"
                onMouseEnter={e => showTip(e, "Exporter la conversation")} onMouseLeave={hideTip}
                onClick={exportConversation}
                style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"1px solid rgba(255,255,255,0.08)", background:"rgba(255,255,255,0.04)", flexShrink:0 }}>
                <span style={{ fontSize:13 }}>📤</span>
              </button>
            )}
            {/* Timer */}
            <button title="" className="no-drag ao-icon-btn"
              onMouseEnter={e => showTip(e, "Timer / Pomodoro")} onMouseLeave={hideTip}
              onClick={() => setTimerOpen(v => !v)}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border: timerOpen || timerRunning ? "1px solid rgba(251,146,60,0.45)" : "1px solid rgba(255,255,255,0.08)", background: timerOpen || timerRunning ? "rgba(251,146,60,0.15)" : "rgba(255,255,255,0.04)", flexShrink:0 }}>
              <span style={{ fontSize:13, lineHeight:1 }}>⏱</span>
            </button>
            {/* Mode compact */}
            <button title="" className="no-drag ao-icon-btn"
              onMouseEnter={e => showTip(e, compactMode ? "Agrandir" : "Mode compact")} onMouseLeave={hideTip}
              onClick={toggleCompact}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border:"1px solid rgba(255,255,255,0.08)", background: compactMode ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.04)", flexShrink:0 }}>
              {compactMode ? <Maximize2 size={14} color="#a5b4fc" /> : <Minimize2 size={14} color="#94a3b8" />}
            </button>
            {/* Settings — Paramètres */}
            <button title="" className="no-drag ao-icon-btn"
              onMouseEnter={e => showTip(e, "Paramètres")} onMouseLeave={hideTip}
              onClick={() => { setShortcutOpen(v => !v); setPendingShortcut(""); setCapturingShortcut(false); }}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:28, height:28, borderRadius:8, cursor:"pointer", border: shortcutOpen ? "1px solid rgba(99,102,241,0.4)" : "1px solid rgba(255,255,255,0.08)", background: shortcutOpen ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.04)", flexShrink:0 }}>
              <Settings size={14} color={shortcutOpen ? "#a5b4fc" : "#94a3b8"} />
            </button>
            {messages.length > 0 && (
              <button
                title="Nouveau chat"
                onClick={() => { setMessages([]); lastPageRef.current = null; setActiveConversationId(null); localStorage.removeItem("omnyx_companion_conv_id"); }}
                style={{ display:"flex", alignItems:"center", justifyContent:"center", width:32, height:32, borderRadius:9, background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.1)", cursor:"pointer", transition:"all 0.15s", flexShrink:0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,0.2)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(99,102,241,0.4)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.1)"; }}>
                <ArrowLeft size={15} color="rgba(255,255,255,0.55)" />
              </button>
            )}
            {!confirmLogout ? (
              <button style={styles.clearBtn} onClick={() => setConfirmLogout(true)}>
                {tr("logout")}
              </button>
            ) : (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "#666" }}>{tr("logout_confirm")}</span>
                <button style={{ ...styles.clearBtn, color: "#f43f5e" }} onClick={() => {
                  localStorage.removeItem("omnyx_token");
                  setView("login");
                  setMessages([]);
                  setConfirmLogout(false);
                }}>{tr("yes")}</button>
                <button style={styles.clearBtn} onClick={() => setConfirmLogout(false)}>{tr("no")}</button>
              </div>
            )}
          </div>
        </div>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    width: "100vw", height: "100vh",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "transparent",
  },
  window: {
    width: 660, maxHeight: 500,
    background: "rgba(8, 8, 16, 0.97)",
    border: "1px solid rgba(124, 58, 237, 0.5)",
    borderRadius: 20,
    backdropFilter: "blur(60px)",
    boxShadow: "0 0 0 1px rgba(124,58,237,0.2), 0 30px 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)",
    overflow: "hidden",
    display: "flex", flexDirection: "column",
  },
  header: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "14px 20px",
    background: "linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.06) 50%, transparent 100%)",
    borderBottom: "1px solid rgba(124,58,237,0.2)",
  },
  logo: {
    width: 32, height: 32, borderRadius: 10,
    background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "white", fontSize: 14, fontWeight: 800, flexShrink: 0,
    boxShadow: "0 0 20px rgba(124,58,237,0.6), 0 0 40px rgba(124,58,237,0.2)",
  },
  logoText: { fontWeight: 700, fontSize: 15, flexShrink: 0 },
  mainInput: {
    flex: 1, background: "transparent", border: "none", outline: "none",
    color: "white", fontSize: 15, fontFamily: "inherit",
  },
  spinner: {
    width: 16, height: 16, borderRadius: "50%",
    border: "2px solid rgba(99,102,241,0.2)",
    borderTopColor: "#6366f1",
    animation: "spin 0.8s linear infinite",
    flexShrink: 0,
  },
  messages: {
    flex: 1, overflowY: "auto", padding: "14px 20px",
    maxHeight: 340, display: "flex", flexDirection: "column" as const, gap: 14,
  },
  userMsg: { textAlign: "right", display: "flex", flexDirection: "column" as const, alignItems: "flex-end" },
  assistantMsg: { textAlign: "left", display: "flex", flexDirection: "column" as const, alignItems: "flex-start" },
  msgRole: { fontSize: 10, color: "#4c4c6b", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 5 },
  msgContent: {
    fontSize: 13, lineHeight: 1.7,
    whiteSpace: "pre-wrap", wordBreak: "break-word",
    padding: "10px 14px", borderRadius: 14,
    maxWidth: "88%",
  },
  quickActions: { padding: "16px 20px" },
  quickTitle: { fontSize: 10, color: "#4c4c6b", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 },
  quickGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 },
  quickBtn: {
    display: "flex", alignItems: "center", gap: 9,
    padding: "10px 13px", borderRadius: 11,
    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
    cursor: "pointer", textAlign: "left",
  },
  quickLabel: { color: "#6b6b8a", fontSize: 12 },
  footer: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 20px",
    background: "linear-gradient(0deg, rgba(0,0,0,0.3) 0%, transparent 100%)",
    borderTop: "1px solid rgba(255,255,255,0.04)",
  },
  footerHint: { fontSize: 10, color: "#2a2a3a", letterSpacing: "0.5px" },
  clearBtn: {
    fontSize: 11, color: "#444", background: "none", border: "none",
    cursor: "pointer", padding: "2px 6px",
  },
  subtitle: { color: "#555", fontSize: 13, padding: "0 20px", marginTop: -4 },
  form: { display: "flex", flexDirection: "column", gap: 10, padding: "18px 20px" },
  input: {
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 11, padding: "11px 15px", color: "white", fontSize: 14,
    outline: "none", fontFamily: "inherit",
  },
  button: {
    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
    border: "none", borderRadius: 11, padding: "12px", color: "white",
    fontSize: 14, fontWeight: 600, cursor: "pointer",
  },
  error: { color: "#f43f5e", fontSize: 12 },
  hint: { color: "#444", fontSize: 11, padding: "8px 18px", textAlign: "center" },
  taskCard: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "7px 4px", borderRadius: 8,
    marginBottom: 4,
  },
  taskDot: {
    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
  },
  taskTitle: {
    flex: 1, color: "#d4d4d4", fontSize: 12, cursor: "pointer",
    whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis",
  },
  taskDoneBtn: {
    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 6, color: "#6ee7b7", fontSize: 11, cursor: "pointer",
    padding: "2px 7px", flexShrink: 0,
  },
  suggestions: {
    position: "absolute" as const, top: "100%", left: 0, right: 0, zIndex: 100,
    background: "rgba(20,20,30,0.98)", border: "1px solid rgba(99,102,241,0.3)",
    borderRadius: 10, marginTop: 4, overflow: "hidden",
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  },
  suggestionItem: {
    display: "flex", alignItems: "center", gap: 10,
    width: "100%", padding: "9px 14px", background: "none",
    border: "none", cursor: "pointer", textAlign: "left" as const,
    borderBottom: "1px solid rgba(255,255,255,0.05)",
    transition: "background 0.1s",
  },
  suggestionName: { color: "#e2e2e2", fontSize: 13 },
};
