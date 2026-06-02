export const API_BASE = '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function apiGetJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path));
  } catch {
    throw new Error('Không kết nối được server backend (port 5000). Chạy lại: npm.cmd run dev');
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Không kết nối được server backend (port 5000). Chạy lại: npm.cmd run dev');
  }

  if (!res.ok) {
    const text = await res.text();
    if (text.includes('Cannot POST') || text.includes('<!DOCTYPE')) {
      throw new Error(
        `Server chưa có API ${path}. Dừng terminal cũ (Ctrl+C) rồi chạy lại: npm.cmd run dev`
      );
    }
    try {
      const json = JSON.parse(text) as { error?: string };
      throw new Error(json.error || text);
    } catch (parseErr) {
      if (parseErr instanceof Error && parseErr.message.includes('Server chưa có')) {
        throw parseErr;
      }
      throw new Error(text.slice(0, 300));
    }
  }
  return res.json();
}

export async function consumeSse(
  response: Response,
  onEvent: (data: Record<string, unknown>) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Trình duyệt không hỗ trợ stream phản hồi từ server');

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (!part.startsWith('data: ')) continue;
      try {
        onEvent(JSON.parse(part.substring(6)));
      } catch {
        throw new Error(`Phản hồi server không hợp lệ: ${part.slice(0, 120)}`);
      }
    }
  }
}

export async function apiPostSse(
  path: string,
  body: unknown,
  onEvent: (data: Record<string, unknown>) => void
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'Không kết nối được server backend (port 5000). Chạy lại: npm.cmd run dev'
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  await consumeSse(res, onEvent);
}
