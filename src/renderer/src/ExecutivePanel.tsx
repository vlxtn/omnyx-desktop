import { useEffect } from "react";
import { Zap, BarChart2, Target, Lightbulb } from "lucide-react";
import { sendMessageStream, Task, completeTask as apiCompleteTask } from "./api";

function getLiveTime() {
  const now = new Date();
  const hour = now.getHours();
  return {
    greeting: hour < 12 ? "Bonjour" : hour < 18 ? "Bon après-midi" : "Bonsoir",
    dateStr: now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }),
    timeStr: now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
  };
}

interface Props {
  tasks: Task[];
  briefing: string;
  briefingLoading: boolean;
  setBriefing: (v: string) => void;
  setBriefingLoading: (v: boolean) => void;
  completeTask: typeof apiCompleteTask;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setExecutiveMode: (v: boolean) => void;
  setMessages: React.Dispatch<React.SetStateAction<{ role: "user" | "assistant"; content: string }[]>>;
  setLoading: (v: boolean) => void;
}

async function generateBriefing(tasks: Task[], setBriefing: (v: string) => void, setBriefingLoading: (v: boolean) => void) {
  setBriefingLoading(true);
  setBriefing("");
  const { dateStr, timeStr } = getLiveTime();
  const urgent = tasks.filter(t => t.priority === "urgent");
  const high = tasks.filter(t => t.priority === "high");
  const total = tasks.length;

  const taskList = tasks.slice(0, 6).map(t => `- [${t.priority}] ${t.title}`).join("\n");
  const prompt = `Tu es mon assistant exécutif. Aujourd'hui c'est ${dateStr}, il est ${timeStr}.

Voici mon tableau de bord :
• ${urgent.length} tâche(s) urgente(s)
• ${high.length} tâche(s) importante(s)
• ${total} tâche(s) au total

Mes tâches :
${taskList || "Aucune tâche en cours."}

Génère un briefing exécutif structuré avec :
1. Un message d'accueil personnalisé selon l'heure
2. La situation actuelle en 1-2 phrases
3. Les 2-3 actions prioritaires immédiates
4. Une recommandation stratégique pour aujourd'hui

Sois direct, motivant et concis. Pas plus de 150 mots.`;

  try {
    let full = "";
    for await (const ev of sendMessageStream(prompt, "executive")) {
      if (ev.type === "delta") {
        full += ev.content;
        setBriefing(full);
      } else if (ev.type === "done" && ev.clean_content) {
        setBriefing(ev.clean_content);
      }
    }
  } catch {
    setBriefing("Impossible de générer le briefing. Vérifie ta connexion.");
  } finally {
    setBriefingLoading(false);
  }
}

export default function ExecutivePanel({ tasks, briefing, briefingLoading, setBriefing, setBriefingLoading, completeTask, setTasks, setExecutiveMode, setMessages, setLoading }: Props) {
  const { greeting, dateStr, timeStr } = getLiveTime();
  const urgent = tasks.filter(t => t.priority === "urgent");
  const high = tasks.filter(t => t.priority === "high");

  // Auto-génère le briefing à l'ouverture
  useEffect(() => {
    if (!briefing && !briefingLoading) {
      generateBriefing(tasks, setBriefing, setBriefingLoading);
    }
  }, []);

  const QUICK_ACTIONS = [
    { Icon: Zap,        label: "Action immédiate", color: "#a5b4fc", prompt: "Quelle est l'action la plus importante que je dois faire dans la prochaine heure ?" },
    { Icon: BarChart2,  label: "Bilan rapide",     color: "#34d399", prompt: "Donne-moi un bilan rapide de l'état de mes tâches et de ma productivité." },
    { Icon: Target,     label: "Focus du jour",    color: "#f9a8d4", prompt: "Sur quoi devrais-je me concentrer aujourd'hui pour avoir le plus d'impact ?" },
    { Icon: Lightbulb,  label: "Suggestions",      color: "#fbbf24", prompt: "Quelles actions proactives me conseilles-tu pour avancer sur mes objectifs ?" },
  ];

  return (
    <div className="ao-panel" style={{ borderBottom: "1px solid rgba(99,102,241,0.15)", background: "linear-gradient(180deg, rgba(8,8,20,0.8) 0%, rgba(8,8,16,0.6) 100%)", overflowY: "auto" as const, maxHeight: 360 }}>

      {/* En-tête */}
      <div style={{ padding: "12px 18px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <p style={{ fontSize: 13, color: "#a5b4fc", fontWeight: 700 }}>{greeting}</p>
          <p style={{ fontSize: 10, color: "#3a3a5a", marginTop: 1 }}>{dateStr} · {timeStr}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {urgent.length > 0 && <span style={{ display:"flex", alignItems:"center", gap:4, background: "rgba(244,63,94,0.15)", border: "1px solid rgba(244,63,94,0.3)", borderRadius: 20, padding: "2px 8px", fontSize: 10, color: "#f43f5e" }}><span style={{ width:5, height:5, borderRadius:"50%", background:"#f43f5e", display:"inline-block" }}/>{urgent.length} urgent{urgent.length > 1 ? "s" : ""}</span>}
          {high.length > 0 && <span style={{ display:"flex", alignItems:"center", gap:4, background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 20, padding: "2px 8px", fontSize: 10, color: "#f59e0b" }}><span style={{ width:5, height:5, borderRadius:"50%", background:"#f59e0b", display:"inline-block" }}/>{high.length} important{high.length > 1 ? "s" : ""}</span>}
        </div>
      </div>

      {/* Briefing IA */}
      <div style={{ padding: "10px 18px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        {briefingLoading && !briefing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#4c4c6b", fontSize: 12 }}>
            <div style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid rgba(99,102,241,0.2)", borderTopColor: "#6366f1", animation: "spin 0.8s linear infinite" }} />
            Génération du briefing…
          </div>
        ) : (
          <p style={{ fontSize: 12, color: "#c4c4d4", lineHeight: 1.7, whiteSpace: "pre-wrap" }} className={briefingLoading ? "ao-cursor" : ""}>{briefing}</p>
        )}
        {briefing && !briefingLoading && (
          <button className="no-drag" style={{ background: "none", border: "none", color: "#3a3a5a", cursor: "pointer", fontSize: 10, marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}
            onClick={() => generateBriefing(tasks, setBriefing, setBriefingLoading)}>
            ↺ Régénérer
          </button>
        )}
      </div>

      {/* Tâches prioritaires */}
      {(urgent.length > 0 || high.length > 0) && (
        <div style={{ padding: "10px 18px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <p style={{ fontSize: 9, color: "#3a3a5a", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>À traiter maintenant</p>
          {[...urgent, ...high].slice(0, 3).map(task => (
            <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: task.priority === "urgent" ? "#f43f5e" : "#f59e0b" }} />
              <span style={{ flex: 1, fontSize: 11, color: "#c4c4d4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{task.title}</span>
              <button className="no-drag" style={{ background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 5, color: "#6ee7b7", fontSize: 10, cursor: "pointer", padding: "2px 7px" }}
                onClick={async () => { await completeTask(task.id); setTasks(prev => prev.filter(t => t.id !== task.id)); }}>✓</button>
            </div>
          ))}
        </div>
      )}

      {/* Actions rapides */}
      <div style={{ padding: "10px 18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {QUICK_ACTIONS.map(a => (
          <button key={a.label} className="no-drag ao-quick-btn"
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 9, cursor: "pointer", textAlign: "left" as const }}
            onClick={async () => {
              setExecutiveMode(false);
              setMessages(prev => [...prev, { role: "user" as const, content: a.label }]);
              setLoading(true);
              const taskList = tasks.length > 0
                ? tasks.slice(0, 8).map(t => `- [${t.priority}] ${t.title} (${t.status})`).join("\n")
                : "Aucune tâche en cours.";
              const { dateStr: d, timeStr: t } = getLiveTime();
              const fullPrompt = `Contexte Omnyx — ${d} ${t}\nTâches :\n${taskList}\n\n${a.prompt}`;
              try {
                let full = "";
                setMessages(prev => [...prev, { role: "assistant" as const, content: "" }]);
                for await (const ev of sendMessageStream(fullPrompt, "executive")) {
                  if (ev.type === "delta") { full += ev.content; setMessages(prev => { const m = [...prev]; m[m.length - 1] = { role: "assistant", content: full }; return m; }); }
                  else if (ev.type === "done" && ev.clean_content) { setMessages(prev => { const m = [...prev]; m[m.length - 1] = { role: "assistant", content: ev.clean_content }; return m; }); }
                }
              } catch {} finally { setLoading(false); }
            }}>
            <div style={{ width:22, height:22, borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", background:`${a.color}18`, flexShrink:0 }}>
              <a.Icon size={11} color={a.color} />
            </div>
            <span style={{ fontSize: 11, color: "#8888aa" }}>{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
