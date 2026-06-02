export type TranslationProvider = 'gemini' | 'openrouter';

export interface OpenRouterModelOption {
  id: string;
  name: string;
  description?: string;
  free?: boolean;
}

export const OPENROUTER_MODELS: OpenRouterModelOption[] = [
  {
    id: 'google/gemini-2.0-flash-exp:free',
    name: 'Gemini 2.0 Flash (Free)',
    description: 'Miễn phí, nhanh',
    free: true,
  },
  {
    id: 'google/gemini-2.5-flash-preview',
    name: 'Gemini 2.5 Flash Preview',
    description: 'Chất lượng tốt, trả phí thấp',
  },
  {
    id: 'google/gemini-2.5-pro-preview',
    name: 'Gemini 2.5 Pro Preview',
    description: 'Chất lượng cao nhất',
  },
  {
    id: 'deepseek/deepseek-chat-v3-0324',
    name: 'DeepSeek V3',
    description: 'Rẻ, dịch tốt',
  },
  {
    id: 'qwen/qwen-2.5-72b-instruct',
    name: 'Qwen 2.5 72B',
    description: 'Mạnh với tiếng Trung',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B',
    description: 'Đa năng',
  },
  {
    id: 'anthropic/claude-3.5-haiku',
    name: 'Claude 3.5 Haiku',
    description: 'Nhanh, chính xác',
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    description: 'OpenAI rẻ',
  },
];

export function isValidGeminiApiKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length < 20) return false;
  // Legacy (AIzaSy...) và key mới từ Google AI Studio (AQ....)
  return /^AIzaSy/i.test(trimmed) || /^AQ\./i.test(trimmed);
}

export function isValidOpenRouterApiKey(key: string): boolean {
  const trimmed = key.trim();
  return /^sk-(or|proj)-/i.test(trimmed) && trimmed.length >= 30;
}

/**
 * Tách key theo Enter thật; gộp dòng bị xuống dòng do ô nhập hẹp (key dài).
 */
export function parseApiKeysFromText(
  raw: string,
  provider: TranslationProvider
): string[] {
  const keyStart =
    provider === 'openrouter'
      ? /^(sk-or-|sk-proj-)/i
      : /^(AIzaSy|AQ\.)/i;

  const lines = raw
    .split(/[\r\n]+/)
    .map((line) => line.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ''))
    .filter(Boolean);

  if (lines.length === 0) return [];

  const merged: string[] = [];
  for (const part of lines) {
    if (keyStart.test(part) || merged.length === 0) {
      merged.push(part);
    } else {
      merged[merged.length - 1] += part;
    }
  }

  return merged.filter((k) => k.length > 10);
}

export const DEFAULT_OPENROUTER_MODEL = OPENROUTER_MODELS[0].id;

/** 0 = tự động theo độ dài dòng phụ đề */
export const TRANSLATION_BATCH_OPTIONS = [
  { value: 0, label: 'Tự động (40–200 dòng)' },
  { value: 80, label: '80 dòng / batch' },
  { value: 120, label: '120 dòng / batch' },
  { value: 150, label: '150 dòng / batch' },
  { value: 200, label: '200 dòng / batch (tối đa)' },
] as const;

export function estimateBatchSize(
  lineCount: number,
  avgCharsPerLine: number,
  userBatchSize: number
): number {
  if (userBatchSize > 0) {
    return Math.max(40, Math.min(userBatchSize, 200));
  }
  let size = avgCharsPerLine < 40 ? 120 : avgCharsPerLine < 80 ? 80 : 50;
  if (lineCount > 500) size = Math.min(size + 25, 200);
  if (lineCount > 5000) size = Math.min(size + 25, 200);
  return Math.max(40, Math.min(size, 200));
}
