import { api } from "./api";

const PREFIX = "omnyx:desktop:";
const TTL = 5 * 60 * 1000;

export function getCached<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts < TTL) return data as T;
    return undefined;
  } catch { return undefined; }
}

export function saveToCache(key: string, data: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

export async function fetchStale<T>(url: string, onData: (data: T) => void): Promise<void> {
  const cached = getCached<T>(url);
  if (cached !== undefined) onData(cached);
  try {
    const { data } = await api.get<T>(url);
    onData(data);
    saveToCache(url, data);
  } catch {}
}
