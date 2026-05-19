export interface ContextAction {
  label: string;
  icon: string;
  prompt: string;
  agentType?: "executive" | "research";
}

export interface AppContext {
  id: string;
  label: string;
  icon: string;
  color: string;
  match: (url: string, title?: string) => boolean;
  actions: ContextAction[];
  suggestions: string[];
}

export const CONTEXTS: AppContext[] = [
  {
    id: "linkedin",
    label: "LinkedIn",
    icon: "💼",
    color: "#0077b5",
    match: (url) => url.includes("linkedin.com"),
    actions: [
      { label: "Analyser profil",       icon: "🔍", prompt: "Analyse ce profil LinkedIn et résume le parcours, les compétences et les expériences clés." },
      { label: "Générer message",        icon: "✉️", prompt: "Génère un message de prise de contact professionnel et personnalisé pour cette personne." },
      { label: "Sauvegarder contact",    icon: "💾", prompt: "Mémorise ce contact LinkedIn avec ses informations clés." },
      { label: "Créer tâche follow-up",  icon: "✅", prompt: "Crée une tâche urgente de suivi pour ce contact LinkedIn." },
    ],
    suggestions: ["Veux-tu analyser ce profil ?", "Générer un message de prise de contact ?"],
  },
  {
    id: "gmail",
    label: "Gmail",
    icon: "📧",
    color: "#ea4335",
    match: (url) => url.includes("mail.google.com"),
    actions: [
      { label: "Résumer email",    icon: "📋", prompt: "Résume cet email en 3 points clés." },
      { label: "Préparer réponse", icon: "✍️", prompt: "Prépare une réponse professionnelle et concise à cet email." },
      { label: "Prioriser",        icon: "⚡", prompt: "Analyse l'urgence de cet email et indique si une action rapide est nécessaire." },
      { label: "Créer tâche",      icon: "✅", prompt: "Crée une tâche à partir de cet email avec la priorité appropriée." },
    ],
    suggestions: ["Veux-tu résumer cet email ?", "Préparer une réponse ?"],
  },
  {
    id: "youtube",
    label: "YouTube",
    icon: "▶️",
    color: "#ff0000",
    match: (url) => url.includes("youtube.com") || url.includes("youtu.be"),
    actions: [
      { label: "Résumer vidéo",      icon: "📋", prompt: "Résume le contenu et les points clés de cette vidéo YouTube." },
      { label: "Points clés",        icon: "🎯", prompt: "Extrais les 5 points les plus importants de cette vidéo." },
      { label: "Sauvegarder",        icon: "💾", prompt: "Sauvegarde cette vidéo dans ma mémoire avec une description." },
      { label: "Créer note",         icon: "📝", prompt: "Crée une note structurée sur le contenu de cette vidéo." },
    ],
    suggestions: ["Veux-tu résumer cette vidéo ?", "Extraire les points clés ?"],
  },
  {
    id: "github",
    label: "GitHub",
    icon: "⚙️",
    color: "#333",
    match: (url) => url.includes("github.com"),
    actions: [
      { label: "Analyser repo",     icon: "🔍", prompt: "Analyse ce repository GitHub : stack, objectif, qualité du code et activité." },
      { label: "Résumer PR/issue",  icon: "📋", prompt: "Résume cette pull request ou issue GitHub." },
      { label: "Points d'amélio.",  icon: "💡", prompt: "Suggère des améliorations pour ce projet GitHub." },
      { label: "Sauvegarder",       icon: "💾", prompt: "Sauvegarde ce projet dans ma mémoire." },
    ],
    suggestions: ["Veux-tu analyser ce repo ?"],
  },
  {
    id: "article",
    label: "Article",
    icon: "📰",
    color: "#6366f1",
    match: (url) => {
      const articleDomains = ["medium.com", "substack.com", "notion.so", "lesechos.fr", "lefigaro.fr", "lemonde.fr", "leparisien.fr", "bfmtv.com", "20minutes.fr", "huffingtonpost.fr"];
      return articleDomains.some(d => url.includes(d)) || (url.startsWith("http") && !url.includes("app.") && !url.includes("console."));
    },
    actions: [
      { label: "Résumer",           icon: "📋", prompt: "Fais un résumé clair et structuré de cet article.", agentType: "research" },
      { label: "Points clés",       icon: "🎯", prompt: "Extrais les 5 points essentiels de cet article." },
      { label: "Sauvegarder",       icon: "💾", prompt: "Sauvegarde cet article dans ma mémoire avec les infos clés." },
      { label: "Rechercher sujet",  icon: "🔍", prompt: "Recherche plus d'informations sur le sujet principal de cet article.", agentType: "research" },
    ],
    suggestions: ["Veux-tu résumer cet article ?", "Sauvegarder dans ta mémoire ?"],
  },
  {
    id: "notion",
    label: "Notion",
    icon: "📓",
    color: "#000",
    match: (url) => url.includes("notion.so") || url.includes("notion.com"),
    actions: [
      { label: "Résumer page",      icon: "📋", prompt: "Résume le contenu de cette page Notion." },
      { label: "Extraire tâches",   icon: "✅", prompt: "Extrais toutes les tâches et actions à faire de cette page." },
      { label: "Créer note",        icon: "📝", prompt: "Crée une note condensée de cette page Notion." },
      { label: "Sauvegarder",       icon: "💾", prompt: "Sauvegarde les infos importantes de cette page." },
    ],
    suggestions: ["Veux-tu extraire les tâches ?"],
  },
];

export function detectContext(urlOrTitle: string): AppContext | null {
  if (!urlOrTitle) return null;
  const s = urlOrTitle.toLowerCase();
  // Détection par URL (http) ou par titre de fenêtre
  const matched = CONTEXTS.find(c => {
    if (urlOrTitle.startsWith("http")) return c.match(urlOrTitle);
    // Détection par mots-clés dans le titre
    const keywords: Record<string, string[]> = {
      linkedin: ["linkedin"],
      gmail: ["gmail", "google mail"],
      youtube: ["youtube"],
      github: ["github"],
      notion: ["notion"],
      article: ["parisien", "lemonde", "figaro", "bfm", "20minutes", "huffington", "medium", "substack", "liberation", "lexpress"],
    };
    const keys = keywords[c.id] || [];
    return keys.some(k => s.includes(k));
  });
  return matched ?? null;
}
