import type { SubtitleItem } from './subtitleUtils';

export function srtTimestampToSeconds(ts: string): number {
  const m = ts.trim().match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return 0;
  const ms = m[4].padEnd(3, '0').slice(0, 3);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(ms) / 1000;
}

export function findActiveSubtitleIndex(subs: SubtitleItem[], timeSec: number): number {
  let best = -1;
  let bestStart = -Infinity;
  for (let i = 0; i < subs.length; i++) {
    const start = srtTimestampToSeconds(subs[i].start);
    const end = srtTimestampToSeconds(subs[i].end);
    if (timeSec >= start - 0.02 && timeSec <= end + 0.02 && start >= bestStart) {
      bestStart = start;
      best = i;
    }
  }
  return best;
}
