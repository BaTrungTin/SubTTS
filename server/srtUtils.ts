import fs from 'fs';

export interface SubtitleItem {
  id: string;
  start: string;
  end: string;
  text: string;
}

const SRT_REGEX =
  /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|\r?\n$|$)/g;

/** Files above this size use server-side translation without loading all lines into the browser. */
export const LARGE_SRT_BYTES = 5 * 1024 * 1024;

/** SSE responses larger than this are written to disk and returned as a file path. */
export const MAX_SSE_CONTENT_BYTES = 2 * 1024 * 1024;

export function parseSrtContent(content: string | null | undefined): SubtitleItem[] {
  if (content == null || typeof content !== 'string') {
    throw new Error('Nội dung SRT không hợp lệ — hãy import lại file phụ đề.');
  }
  if (!content.trim()) {
    throw new Error('File SRT trống hoặc không đọc được nội dung.');
  }

  const matches = [...content.matchAll(SRT_REGEX)];
  return matches.map((m) => ({
    id: m[1],
    start: m[2],
    end: m[3],
    text: m[4].replace(/\r?\n/g, ' ').trim(),
  }));
}

export function readSrtFile(filePath: string): SubtitleItem[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSrtContent(content);
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function countCjkChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
}

function isMostlyChinese(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const letters = trimmed.replace(/\s+/g, '').length;
  if (letters === 0) return false;
  return countCjkChars(trimmed) / letters >= 0.35;
}

export function isValidTranslation(original: string, translated: string): boolean {
  const orig = original?.trim() || '';
  const trans = translated?.trim() || '';
  if (!orig || !trans) return false;
  if (trans === orig) return false;
  if (isMostlyChinese(trans)) return false;
  return true;
}

export function countValidTranslations(
  originals: SubtitleItem[],
  translated: SubtitleItem[]
): number {
  return originals.filter((sub, i) =>
    isValidTranslation(sub.text, translated[i]?.text || '')
  ).length;
}

export function timeKey(start: string, end: string): string {
  return `${start.trim()}|${end.trim()}`;
}

/** Ghép bản dịch VI vào phụ đề gốc theo mốc thời gian — trả map index → text đã dịch hợp lệ */
export function buildExistingTranslationsFromViFile(
  chineseSubs: SubtitleItem[],
  viSubs: SubtitleItem[]
): Record<number, string> {
  const byExact = new Map<string, string>();
  const byStart = new Map<string, string>();

  for (const v of viSubs) {
    const text = v.text?.trim();
    if (!text) continue;
    byExact.set(timeKey(v.start, v.end), text);
    if (!byStart.has(v.start.trim())) {
      byStart.set(v.start.trim(), text);
    }
  }

  const map: Record<number, string> = {};
  chineseSubs.forEach((sub, i) => {
    const candidate =
      byExact.get(timeKey(sub.start, sub.end)) ?? byStart.get(sub.start.trim()) ?? '';
    if (isValidTranslation(sub.text, candidate)) {
      map[i] = candidate.trim();
    }
  });
  return map;
}
