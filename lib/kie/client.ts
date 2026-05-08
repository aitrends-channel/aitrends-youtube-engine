import { getSettings } from "@/lib/settings";

const KIE_BASE_URL = "https://api.kie.ai";

async function getKieKey(userId?: string): Promise<string> {
  if (userId) {
    const { kie_api_key } = await getSettings(userId);
    if (!kie_api_key) throw new Error("KIE API key not configured. Add it in Settings.");
    return kie_api_key;
  }
  const key = process.env.KIE_API_KEY ?? "";
  if (!key) throw new Error("KIE API key not configured.");
  return key;
}

export async function kieRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  userId?: string
): Promise<T> {
  const kie_api_key = await getKieKey(userId);

  const res = await fetch(`${KIE_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${kie_api_key}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`kie.ai error ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export async function kieRequestBinary(
  endpoint: string,
  body: object,
  userId?: string
): Promise<ArrayBuffer> {
  const kie_api_key = await getKieKey(userId);

  const res = await fetch(`${KIE_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kie_api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`kie.ai error ${res.status}: ${text}`);
  }

  return res.arrayBuffer();
}
