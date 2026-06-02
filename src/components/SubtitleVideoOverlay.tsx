import { useEffect, useRef, useState } from 'react';
import type { SubtitleItem } from '../utils/subtitleUtils';
import { findActiveSubtitleIndex, srtTimestampToSeconds } from '../utils/srtTime';

interface SubtitleVideoOverlayProps {
  subtitles: SubtitleItem[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

export function SubtitleVideoOverlay({
  subtitles,
  videoRef,
  enabled,
  activeIndex,
  onActiveIndexChange,
}: SubtitleVideoOverlayProps) {
  const [currentText, setCurrentText] = useState('');
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled || subtitles.length === 0) {
      setCurrentText('');
      return;
    }

    const onTimeUpdate = () => {
      const idx = findActiveSubtitleIndex(subtitles, video.currentTime);
      if (idx !== activeIndexRef.current) {
        onActiveIndexChange(idx);
      }
      if (idx >= 0) {
        setCurrentText(subtitles[idx].text);
      } else {
        setCurrentText('');
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onTimeUpdate);
    onTimeUpdate();
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeked', onTimeUpdate);
    };
  }, [subtitles, videoRef, enabled, onActiveIndexChange]);

  if (!enabled || subtitles.length === 0) {
    return null;
  }

  const duration = videoRef.current?.duration || 0;

  return (
    <div className="absolute inset-0 pointer-events-none z-[15] flex flex-col justify-end">
      {duration > 0 && (
        <div className="px-2 pt-6 pb-1 bg-gradient-to-t from-black/80 to-transparent">
          <div className="relative h-1.5 rounded-full bg-white/10 overflow-hidden">
            {subtitles.map((sub, i) => {
              const start = srtTimestampToSeconds(sub.start);
              const end = srtTimestampToSeconds(sub.end);
              const left = (start / duration) * 100;
              const width = Math.max(0.15, ((end - start) / duration) * 100);
              const isActive = i === activeIndex;
              return (
                <div
                  key={sub.id}
                  className={`absolute top-0 h-full rounded-sm ${
                    isActive ? 'bg-cyan-400' : 'bg-cyan-500/35'
                  }`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })}
          </div>
        </div>
      )}

      {currentText ? (
        <div className="px-3 pb-3 pt-1 flex justify-center">
          <div className="max-w-[95%] px-3 py-2 rounded-lg bg-black/75 border border-cyan-500/40 text-center shadow-lg">
            {activeIndex >= 0 && (
              <span className="block text-[9px] font-mono text-cyan-400/80 mb-0.5">
                #{subtitles[activeIndex].id}
              </span>
            )}
            <p className="text-sm text-white font-medium leading-snug break-words">{currentText}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
