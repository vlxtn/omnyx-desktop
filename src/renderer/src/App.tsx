import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, Clock, FileText, Search, Zap, Smartphone, ArrowLeft, PanelRight, PanelTop, Sparkles, Globe, FolderOpen, ListChecks } from "lucide-react";
import logoImg from "./assets/logo.png";
import { useT } from "./i18n";
import { sendMessage, sendMessageStream, analyzeContent, login, getTasks, completeTask, createTask, Task, getConversations, getConversationMessages, searchConversations, SearchResult, Conversation, api } from "./api";
import { detectContext, AppContext } from "./contexts";
import { generateSuggestions } from "./suggestions";
import ExecutivePanel from "./ExecutivePanel";

interface Message {
  role: "user" | "assistant";
  content: string;
  ts?: string;
}

function now() { return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }

type ViewState = "login" | "chat";

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
  const isVertical = layout === "vertical";
  const [searchLoading, setSearchLoading] = useState(false);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const [pendingReminder, setPendingReminder] = useState<string | null>(null);
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

  useEffect(() => {
    const token = localStorage.getItem("omnyx_token");
    if (token) {
      setView("chat");
      // Afficher les tâches cachées immédiatement
      try {
        const cachedTasks = localStorage.getItem("omnyx_desktop_tasks_cache");
        if (cachedTasks) setTasks(JSON.parse(cachedTasks));
      } catch {}
      // Appliquer la langue depuis le cache profil
      try {
        const cachedProfile = localStorage.getItem("omnyx_desktop_profile_cache");
        if (cachedProfile) {
          const p = JSON.parse(cachedProfile);
          if (p.language) setLanguage(p.language);
        }
      } catch {}
      // Sync raccourci depuis le profil utilisateur
      api.get("/api/auth/me").then(({ data }) => {
        if (data.companion_shortcut) {
          // @ts-ignore
          window.api?.updateShortcut(data.companion_shortcut);
        }
        setLanguage(data.language || "fr");
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
      .replace(/[îï]/g, "i").replace(/[ôö]/g, "o").replace(/[ç]/g, "c");
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

    const hasOpen = OPEN_WORDS.some(w => t.includes(norm(w)));
    const hasFile = FILE_WORDS.some(w => t.includes(norm(w)));
    const looksLikeUrl = /\.(com|fr|io|net|org|co|app|dev)/.test(t) || t.includes("http") || t.includes("www");

    // Detect app anywhere in the text
    const foundAppKey = Object.keys(APP_MAP).sort((a, b) => b.length - a.length).find(k => t.includes(norm(k)));

    // Open app — known or unknown
    if (hasOpen && !looksLikeUrl) {
      const appName = foundAppKey ? APP_MAP[foundAppKey] : text.replace(/^.*(ouvre|lance|demarre|start|mets|active|utilise|besoin de|veux)\s+/i, "").replace(/[?!.]/g, "").trim();
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
  }, []);

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

    const userMsg: Message = { role: "user", content: text, ts: now() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      // 1. Intention locale rapide (ouvrir app/URL)
      const intent = await handleIntent(text);
      if (intent.handled) {
        setMessages(prev => [...prev, { role: "assistant", content: intent.result ?? "" }]);
        setLoading(false);
        setTimeout(() => inputRef.current?.focus(), 50);
        return;
      }

      // 2. Si une page a été analysée, toute question suivante utilise son contenu comme contexte
      if (lastPageRef.current) {
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

      for await (const event of sendMessageStream(text, "executive", activeConversationId)) {
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
      <div style={{
        ...styles.window,
        ...(isVertical ? { width: 380, maxHeight: 680, minHeight: 300 } : { width: 660, maxHeight: 500 }),
      }} className="ao-window">
        {/* En-tête — zone de déplacement */}
        <div style={{
          ...styles.header,
          ...(isVertical ? { flexWrap: "wrap" as const, gap: 8 } : {}),
        }} className="drag">
          {/* Logo + titre */}
          <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
            <img src={logoImg} alt="Omnyx" style={{ width:32, height:32, borderRadius:10, objectFit:"cover", flexShrink:0 }} />
            <span className="ao-logo-text" style={{ fontSize: 14, flexShrink: 0 }}>Omnyx</span>
          </div>
          {/* Toggle layout */}
          <button className="no-drag" title={isVertical ? "Mode horizontal" : "Mode vertical"}
            onClick={toggleLayout}
            style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.08)", cursor:"pointer", flexShrink:0, marginLeft: isVertical ? "auto" : 0 }}>
            {isVertical
              ? <PanelTop size={12} color="rgba(255,255,255,0.4)" />
              : <PanelRight size={12} color="rgba(255,255,255,0.4)" />}
          </button>
          <div style={{ flex: 1, position: "relative" as const, ...(isVertical ? { flexBasis:"100%", order: 10 } : {}) }}>
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
          {/* ── Toolbar groupée ── */}
          <div style={{ display:"flex", alignItems:"center", gap:2, padding:"3px", borderRadius:10, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", flexShrink:0, ...(isVertical ? { order:11 } : {}) }}>
            {/* Brain — Executive */}
            <button className="no-drag ao-btn" title="Mode Executive"
              onClick={() => { setBriefing(""); setExecutiveMode(v => !v); }}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, cursor:"pointer", border:"none", background: executiveMode ? "rgba(99,102,241,0.25)" : "transparent", transition:"background 0.15s" }}>
              <Brain size={13} color={executiveMode ? "#a5b4fc" : "rgba(255,255,255,0.4)"} />
            </button>
            {/* Clock — Historique */}
            <button className="no-drag ao-btn" title="Historique"
              onClick={async () => {
                if (!historyOpen) { try { const data = await getConversations(); setConversations(data); } catch {} }
                setHistoryOpen(v => !v);
              }}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, cursor:"pointer", border:"none", background: historyOpen ? "rgba(99,102,241,0.25)" : "transparent", transition:"background 0.15s" }}>
              <Clock size={13} color={historyOpen ? "#a5b4fc" : "rgba(255,255,255,0.4)"} />
            </button>
            {/* FileText — Coller */}
            <button className="no-drag" title="Coller du texte"
              onClick={() => setPasteMode(v => !v)}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, cursor:"pointer", border:"none", background: pasteMode ? "rgba(99,102,241,0.25)" : "transparent", transition:"background 0.15s" }}>
              <FileText size={13} color={pasteMode ? "#a5b4fc" : "rgba(255,255,255,0.4)"} />
            </button>
            {/* BookMarked — Mémoriser */}
            <button className="no-drag" title="Mémoriser quelque chose"
              onClick={() => { setQuickMemoryMode(v => !v); setPasteMode(false); }}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, borderRadius:7, cursor:"pointer", border:"none", background: quickMemoryMode ? "rgba(245,158,11,0.25)" : "transparent", transition:"background 0.15s" }}>
              <Sparkles size={13} color={quickMemoryMode ? "#fcd34d" : "rgba(255,255,255,0.4)"} />
            </button>
            {/* Séparateur */}
            <div style={{ width:1, height:14, background:"rgba(255,255,255,0.08)", margin:"0 2px" }}/>
            {/* Badge tâches */}
            {tasks.length > 0 && (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, borderRadius:6, background: tasks.some(t => t.priority === "urgent") ? "rgba(244,63,94,0.2)" : "rgba(99,102,241,0.2)", padding:"0 4px" }}>
                <span style={{ fontSize:10, fontWeight:700, color: tasks.some(t => t.priority === "urgent") ? "#f87171" : "#a5b4fc" }}>{tasks.length}</span>
              </div>
            )}
          </div>
          <button
            className="no-drag"
            title="Analyser la page actuelle"
            disabled={loading}
            style={{ display:"flex", alignItems:"center", justifyContent:"center", width:30, height:30, borderRadius:9, cursor: loading ? "not-allowed" : "pointer", flexShrink:0, border:"1px solid rgba(99,102,241,0.25)", background:"rgba(99,102,241,0.1)", opacity: loading ? 0.4 : 1, transition:"all 0.15s" }}
            onClick={async () => {
              setLoading(true);
              // @ts-ignore
              window.api?.hideWindow();
              await new Promise(r => setTimeout(r, 600));
              try {
                // @ts-ignore
                const raw: string = await window.api?.getBrowserUrl() || "{}";
                let pageData: { url?: string; content?: string } = {};
                try { pageData = JSON.parse(raw); } catch {}
                const rawUrl = pageData.url || "";
                const content = (pageData.content || "").trim();
                const url = /^https?:\/\/(?!localhost|127\.0\.0\.1).+/.test(rawUrl) ? rawUrl : "";
                // @ts-ignore
                window.api?.showWindow();

                // Page locale (localhost) → message clair
                if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(rawUrl)) {
                  setMessages(prev => [...prev, { role: "assistant" as const, content: "Cette page est locale (localhost) et ne peut pas être analysée. Ouvre une page web externe, puis réessaie." }]);
                } else if (content.length > 100) {
                  lastPageRef.current = { content, url };
                  setMessages(prev => [...prev, { role: "user" as const, content: `${tr("analyze_msg")}${url ? ` : ${url}` : ""}` }]);
                  const data = await analyzeContent(content, undefined, url || undefined);
                  setMessages(prev => [...prev, { role: "assistant", content: data.result || "" }]);
                } else if (url) {
                  lastPageRef.current = { content: "", url };
                  setMessages(prev => [...prev, { role: "user" as const, content: `${tr("analyze_msg")} : ${url}` }]);
                  const data = await analyzeContent("", undefined, url);
                  setMessages(prev => [...prev, { role: "assistant", content: data.result || "" }]);
                } else {
                  setMessages(prev => [...prev, { role: "assistant" as const, content: "Aucun navigateur détecté. Ouvre Chrome ou Edge sur une vraie page web (pas localhost), puis réessaie." }]);
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
          </button>
          {loading && <div style={styles.spinner} />}
        </div>

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
              <div key={i} style={{ marginBottom: 12, display:"flex", flexDirection:"column", alignItems: m.role==="user"?"flex-end":"flex-start" }}>
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
                  background:"linear-gradient(135deg, #4f46e5, #7c3aed)",
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
                  className={m.role==="assistant" && loading && i===messages.length-1 ? "ao-cursor" : ""}>
                  {m.role==="user" ? m.content : (
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

        {/* Pied de page */}
        <div style={styles.footer}>
          <span style={styles.footerHint}>{tr("footer_hint")}</span>
          <div style={{ display: "flex", gap: 8 }}>
            {messages.length > 0 && (
              <button
                title="Nouveau chat"
                onClick={() => { setMessages([]); lastPageRef.current = null; setActiveConversationId(null); }}
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
        </div>
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
