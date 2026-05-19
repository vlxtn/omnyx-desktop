import { Task } from "./api";
import { AppContext } from "./contexts";

export interface Suggestion {
  id: string;
  label: string;
  icon: string;
  action: "message" | "memory" | "analyze" | "executive";
  prompt: string;
}

export function generateSuggestions(
  tasks: Task[],
  context: AppContext | null,
  hasMessages: boolean,
  lastAnalyzed: boolean,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const hour = new Date().getHours();

  // Heure du matin → briefing
  if (hour >= 7 && hour < 11 && !hasMessages) {
    suggestions.push({
      id: "morning_brief",
      icon: "☀️",
      label: "Briefing du matin",
      action: "executive",
      prompt: "Donne-moi mon briefing du matin : priorités, tâches urgentes et ce sur quoi me concentrer aujourd'hui.",
    });
  }

  // Fin de journée → bilan
  if (hour >= 17 && hour < 22 && !hasMessages) {
    suggestions.push({
      id: "end_day",
      icon: "🌙",
      label: "Bilan de la journée",
      action: "message",
      prompt: "Fais-moi un bilan de la journée et aide-moi à préparer demain.",
    });
  }

  // Tâches urgentes
  const urgent = tasks.filter(t => t.priority === "urgent" && t.status === "pending");
  if (urgent.length > 0) {
    suggestions.push({
      id: "urgent_tasks",
      icon: "⚡",
      label: `${urgent.length} tâche${urgent.length > 1 ? "s" : ""} urgente${urgent.length > 1 ? "s" : ""}`,
      action: "executive",
      prompt: `J'ai ces tâches urgentes : ${urgent.map(t => t.title).join(", ")}. Aide-moi à les prioriser et dis-moi par laquelle commencer.`,
    });
  }

  // Contenu analysé récemment → suggérer de sauvegarder
  if (lastAnalyzed) {
    suggestions.push({
      id: "save_memory",
      icon: "💾",
      label: "Sauvegarder en mémoire",
      action: "memory",
      prompt: "Sauvegarde le contenu que je viens d'analyser dans ma mémoire Omnyx.",
    });
    suggestions.push({
      id: "create_task_from",
      icon: "✅",
      label: "Créer une tâche",
      action: "message",
      prompt: "Crée une tâche de suivi basée sur le contenu que je viens d'analyser.",
    });
  }

  // Contexte détecté — suggestions basées sur la page active
  if (context && !lastAnalyzed) {
    context.suggestions.slice(0, 2).forEach((s, i) => {
      suggestions.push({
        id: `ctx_${i}`,
        icon: context.icon,
        label: s,
        action: "analyze",
        prompt: context.actions[i]?.prompt || context.actions[0]?.prompt || s,
      });
    });
  }

  return suggestions.slice(0, 3);
}
