export interface SubtitleItem {
  id: string;
  start: string;
  end: string;
  text: string;
}

/** CJK + kana — coi là chưa dịch nếu bản dịch còn quá nhiều ký tự này */
const CJK_RATIO_THRESHOLD = 0.35;

export function countCjkChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
}

export function isMostlyChinese(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const letters = trimmed.replace(/\s+/g, '').length;
  if (letters === 0) return false;
  return countCjkChars(trimmed) / letters >= CJK_RATIO_THRESHOLD;
}

export function timeKey(start: string, end: string): string {
  return `${start.trim()}|${end.trim()}`;
}

/** Dòng đã dịch hợp lệ: có text, khác gốc, không còn chủ yếu tiếng Trung */
export function isValidTranslation(original: string | undefined, translated: string | undefined): boolean {
  const orig = original?.trim() || '';
  const trans = translated?.trim() || '';
  if (!orig || !trans) return false;
  if (trans === orig) return false;
  if (isMostlyChinese(trans)) return false;
  return true;
}

export function isMissedLine(original: string | undefined, translated: string | undefined): boolean {
  const orig = original?.trim() || '';
  if (!orig) return false;
  return !isValidTranslation(orig, translated);
}

export function mergeViSubtitlesByTimestamp(
  chineseSubs: SubtitleItem[],
  viSubs: SubtitleItem[]
): SubtitleItem[] {
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

  return chineseSubs.map((sub) => {
    const exact = byExact.get(timeKey(sub.start, sub.end));
    const byTime = exact ?? byStart.get(sub.start.trim());
    const candidate = byTime?.trim() || '';
    const text = isValidTranslation(sub.text, candidate) ? candidate : '';
    return { ...sub, text };
  });
}

export function buildExistingTranslationsMap(
  subtitles: SubtitleItem[],
  translatedSubtitles: SubtitleItem[]
): Record<number, string> {
  const map: Record<number, string> = {};
  subtitles.forEach((sub, i) => {
    const translated = translatedSubtitles[i]?.text;
    if (isValidTranslation(sub.text, translated)) {
      map[i] = translated!.trim();
    }
  });
  return map;
}

export function countValidTranslations(
  subtitles: SubtitleItem[],
  translatedSubtitles: SubtitleItem[]
): number {
  return subtitles.filter((sub, i) =>
    isValidTranslation(sub.text, translatedSubtitles[i]?.text)
  ).length;
}

export function countMissedLines(
  subtitles: SubtitleItem[],
  translatedSubtitles: SubtitleItem[]
): number {
  return subtitles.filter((sub, i) =>
    isMissedLine(sub.text, translatedSubtitles[i]?.text)
  ).length;
}
