import axios from "axios";

const BASE_URL = "http://localhost:8000";

export const api = axios.create({ baseURL: BASE_URL, timeout: 60000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("omnyx_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) localStorage.removeItem("omnyx_token");
    return Promise.reject(err);
  }
);

export async function analyzeContent(content: string, question?: string, url?: string) {
  const { data } = await api.post("/api/chat/analyze-content", { content, question, url });
  return data;
}

export async function sendMessage(message: string, agentType = "executive") {
  const { data } = await api.post("/api/chat/message", {
    message,
    agent_type: agentType,
  });
  return data;
}

export async function* sendMessageStream(message: string, agentType = "executive", conversationId?: string | null) {
  const token = localStorage.getItem("omnyx_token");
  const response = await fetch(`${BASE_URL}/api/chat/message/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message, agent_type: agentType, ...(conversationId ? { conversation_id: conversationId } : {}) }),
  });
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return;
      try { yield JSON.parse(raw); } catch {}
    }
  }
}

export async function login(email: string, password: string) {
  const { data } = await api.post("/api/auth/login", { email, password });
  return data;
}

export async function getTasks() {
  const { data } = await api.get("/api/tasks/");
  return (Array.isArray(data) ? data : data?.tasks ?? []) as Task[];
}

export async function createTask(title: string, priority: Task["priority"] = "medium", description?: string) {
  const { data } = await api.post("/api/tasks/", { title, priority, description });
  return data as Task;
}

export async function searchConversations(q: string) {
  const { data } = await api.get(`/api/chat/search?q=${encodeURIComponent(q)}`);
  return data as SearchResult[];
}

export interface SearchResult {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  excerpt: string;
  created_at: string;
}

export async function getConversations() {
  const { data } = await api.get("/api/chat/conversations");
  return data as Conversation[];
}

export async function getConversationMessages(conversationId: string) {
  const { data } = await api.get(`/api/chat/conversations/${conversationId}/messages`);
  return data as ConvMessage[];
}

export interface Conversation {
  id: string;
  title?: string;
  created_at: string;
  updated_at: string;
}

export interface ConvMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export async function completeTask(taskId: string) {
  const { data } = await api.patch(`/api/tasks/${taskId}`, { status: "completed" });
  return data;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | "urgent";
  due_date?: string;
  created_at: string;
}
