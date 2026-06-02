import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Film,
  Sliders,
  Settings,
  Upload,
  Play,
  Cpu,
  Volume2,
  CheckCircle,
  Loader,
  Check,
  FileText,
  Download
} from 'lucide-react';
import { SubtitleCropbox } from './components/SubtitleCropbox';
import { SubtitleVideoOverlay } from './components/SubtitleVideoOverlay';
import { srtTimestampToSeconds } from './utils/srtTime';
import FileBrowser from './components/FileBrowser';
import { apiGetJson, apiPostJson, apiPostSse, apiUrl } from './api/client';
import { Select } from './components/ui/Select';
import { Slider } from './components/ui/Slider';
import { Checkbox } from './components/ui/Checkbox';
import { VOICE_PROVIDERS, VOICE_DATA, DUBBING_MODES } from './constants';
import {
  DEFAULT_OPENROUTER_MODEL,
  estimateBatchSize,
  isValidGeminiApiKey,
  isValidOpenRouterApiKey,
  parseApiKeysFromText,
  OPENROUTER_MODELS,
  TRANSLATION_BATCH_OPTIONS,
  type TranslationProvider,
} from './constants/translationModels';
import {
  buildExistingTranslationsMap,
  countMissedLines,
  countValidTranslations,
  isMissedLine,
  isValidTranslation,
  mergeViSubtitlesByTimestamp,
} from './utils/subtitleUtils';

interface SubtitleItem {
  id: string;
  start: string;
  end: string;
  text: string;
}

interface ParseSubtitlesLarge {
  largeFile: true;
  filePath: string;
  lineCount: number;
  fileSizeBytes: number;
  fileSizeLabel: string;
}

function isLargeSrtResponse(value: unknown): value is ParseSubtitlesLarge {
  return (
    typeof value === 'object' &&
    value !== null &&
    'largeFile' in value &&
    (value as ParseSubtitlesLarge).largeFile === true
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'ocr' | 'translate' | 'voice' | 'mix'>('ocr');
  
  // File states
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<{ duration: number; resolution: string; format: string } | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleItem[]>([]);
  const [translatedSubtitles, setTranslatedSubtitles] = useState<SubtitleItem[]>([]);
  
  // Crop coordinates (normalized 0.0 - 1.0)
  const [cropCoords, setCropCoords] = useState({ xMin: 0.15, yMin: 0.75, xMax: 0.85, yMax: 0.9 });
  
  // Translation settings
  const [translateProvider, setTranslateProvider] = useState<TranslationProvider>('gemini');
  const [geminiKeys, setGeminiKeys] = useState<string>('');
  const [openRouterKeys, setOpenRouterKeys] = useState<string>('');
  const [openRouterModel, setOpenRouterModel] = useState<string>(DEFAULT_OPENROUTER_MODEL);
  const [translationBatchSize, setTranslationBatchSize] = useState(0);
  
  // Voice Settings (3 voices exactly like the CapCut UI reference)
  const [voiceSettings, setVoiceSettings] = useState([
    { provider: 'capcut', voice: 'Giọng nam phổ thông (Việt Nam)', speed: 1.0, volume: 100, pitch: 0 },
    { provider: 'google', voice: 'vi-VN-Standard-C', speed: 1.0, volume: 100, pitch: 0 },
    { provider: 'openai', voice: 'alloy', speed: 1.0, volume: 100, pitch: 0 }
  ]);
  
  // Mixing & Modes settings
  const [dubbingMode, setDubbingMode] = useState('hybrid'); // 'video-priority' or 'hybrid'
  const [keepOriginalAudio, setKeepOriginalAudio] = useState(true);
  const [mixing, setMixing] = useState({
    ai: 100,
    bg: 20,
    voice: 80
  });

  // API credentials for other TTS engines
  const [googleKey, setGoogleKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [elevenlabsKey, setElevenlabsKey] = useState('');

  // OCR state
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState('Sẵn sàng trích xuất');
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrProfile, setOcrProfile] = useState<'accurate' | 'balanced' | 'fast'>('accurate');
  const [ocrDownscale720, setOcrDownscale720] = useState(true);
  const [showSubtitleOnVideo, setShowSubtitleOnVideo] = useState(true);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState(-1);
  const [isCleaningSrt, setIsCleaningSrt] = useState(false);
  const [duplicatePairs, setDuplicatePairs] = useState<
    { indexA: number; indexB: number; kind: string; score: number; textA: string; textB: string; gapSec: number }[]
  >([]);
  const [ocrRuntimeReady, setOcrRuntimeReady] = useState<boolean | null>(null);
  const [ocrEngine, setOcrEngine] = useState<string | null>(null);
  const [ocrEngineMessage, setOcrEngineMessage] = useState<string | null>(null);

  // Translation state
  const [translateProgress, setTranslateProgress] = useState(0);
  const [translateStatus, setTranslateStatus] = useState('Sẵn sàng dịch thuật');
  const [translateLogs, setTranslateLogs] = useState<string[]>([]);
  const [isTranslateRunning, setIsTranslateRunning] = useState(false);

  const pushTranslateLog = (message: string, progress?: number) => {
    const stamp = new Date().toLocaleTimeString('vi-VN');
    setTranslateLogs((prev) => [...prev.slice(-99), `[${stamp}] ${message}`]);
    setTranslateStatus(message);
    if (progress != null) setTranslateProgress(progress);
  };

  // Rendering state
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState('Sẵn sàng kết xuất video');
  const [isRenderRunning, setIsRenderRunning] = useState(false);
  const [renderedVideoPath, setRenderedVideoPath] = useState<string | null>(null);

  // File browser states (for web mode)
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [showSrtBrowser, setShowSrtBrowser] = useState(false);
  const [srtImportMode, setSrtImportMode] = useState<'chinese' | 'vietnamese' | 'resume'>('chinese');
  const [viSrtPath, setViSrtPath] = useState<string | null>(null);
  const [sourceSrtPath, setSourceSrtPath] = useState<string | null>(null);
  const [resumeTranslationsMap, setResumeTranslationsMap] = useState<Record<number, string>>({});
  const [largeSrtMode, setLargeSrtMode] = useState(false);
  const [subtitleLineCount, setSubtitleLineCount] = useState(0);
  const [translatedSrtOutputPath, setTranslatedSrtOutputPath] = useState<string | null>(null);
  const [largeTranslatedCount, setLargeTranslatedCount] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeSubtitleIndex < 0 || !subtitleListRef.current) return;
    const el = subtitleListRef.current.querySelector(
      `[data-sub-idx="${activeSubtitleIndex}"]`
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSubtitleIndex]);

  useEffect(() => {
    apiGetJson<{
      ocrRuntimeReady?: boolean;
      ocrEngine?: string;
      ocrMessage?: string;
    }>('/api/health')
      .then((h) => {
        setOcrRuntimeReady(Boolean(h.ocrRuntimeReady));
        setOcrEngine(typeof h.ocrEngine === 'string' ? h.ocrEngine : null);
        setOcrEngineMessage(typeof h.ocrMessage === 'string' ? h.ocrMessage : null);
      })
      .catch(() => {
        setOcrRuntimeReady(null);
        setOcrEngine(null);
      });
  }, []);

  const handleImportVideo = async () => {
    setShowFileBrowser(true);
  };

  const handleImportSrt = async () => {
    setSrtImportMode('chinese');
    setShowSrtBrowser(true);
  };

  const handleImportViSrt = async () => {
    setSrtImportMode('vietnamese');
    setShowSrtBrowser(true);
  };

  const handleImportResumeViSrt = () => {
    if (!sourceSrtPath && subtitles.length === 0) {
      pushTranslateLog('Import SRT gốc (tiếng Trung) trước, rồi mới import bản dịch để tiếp tục dịch sót.');
      return;
    }
    setSrtImportMode('resume');
    setShowSrtBrowser(true);
  };

  const mergeViProgress = async (
    sourcePath: string,
    viPath: string
  ): Promise<{
    totalCount: number;
    validCount: number;
    missedCount: number;
    existingTranslations: Record<number, string>;
    chineseSubs?: SubtitleItem[];
  }> => {
    try {
      const health = await apiGetJson<{ version?: number; features?: string[] }>('/api/health');
      if (!health.features?.includes('merge-vi-progress')) {
        throw new Error('merge-vi-progress-missing');
      }
      return await apiPostJson('/api/merge-vi-progress', { sourcePath, viPath });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const needsFallback =
        msg.includes('merge-vi-progress') ||
        msg.includes('Cannot POST') ||
        msg === 'merge-vi-progress-missing';

      if (!needsFallback) throw e;

      const sourceParsed = await apiPostJson<SubtitleItem[] | ParseSubtitlesLarge>(
        '/api/parse-subtitles',
        { filePath: sourcePath }
      );
      if (isLargeSrtResponse(sourceParsed)) {
        throw new Error(
          'Server cần khởi động lại để ghép file lớn. Ctrl+C terminal → npm.cmd run dev'
        );
      }
      const viParsed = await apiPostJson<SubtitleItem[]>('/api/parse-subtitles', {
        filePath: viPath,
      });
      if (!Array.isArray(viParsed)) {
        throw new Error('File SRT tiếng Việt không hợp lệ.');
      }
      const merged = mergeViSubtitlesByTimestamp(sourceParsed, viParsed);
      const existingTranslations = buildExistingTranslationsMap(sourceParsed, merged);
      const validCount = Object.keys(existingTranslations).length;
      return {
        totalCount: sourceParsed.length,
        validCount,
        missedCount: sourceParsed.length - validCount,
        existingTranslations,
        chineseSubs: sourceParsed,
      };
    }
  };

  const applyMergeResult = (
    result: {
      totalCount: number;
      validCount: number;
      missedCount: number;
      existingTranslations: Record<number, string>;
      chineseSubs?: SubtitleItem[];
    },
    fallbackChinese?: SubtitleItem[]
  ) => {
    setResumeTranslationsMap(result.existingTranslations);
    setLargeTranslatedCount(result.validCount);
    setSubtitleLineCount(result.totalCount);

    const chinese = result.chineseSubs ?? fallbackChinese ?? subtitles;
    if (!largeSrtMode && chinese.length > 0) {
      setSubtitles(chinese);
      setTranslatedSubtitles(
        chinese.map((sub, i) => ({
          ...sub,
          text: result.existingTranslations[i] || '',
        }))
      );
    }
  };

  const loadResumeViSrt = async (viPath: string) => {
    try {
      if (sourceSrtPath) {
        const result = await mergeViProgress(sourceSrtPath, viPath);
        applyMergeResult(result, subtitles.length > 0 ? subtitles : undefined);

        pushTranslateLog(
          `Đã nạp tiến độ dịch: ${result.validCount}/${result.totalCount} dòng hợp lệ. Còn ${result.missedCount} dòng cần dịch sót.`
        );
        setActiveTab('translate');
        return;
      }

      if (subtitles.length === 0) {
        pushTranslateLog('Import SRT gốc (tiếng Trung) trước, rồi mới import bản dịch.');
        return;
      }

      const viSubs = await apiPostJson<SubtitleItem[]>('/api/parse-subtitles', { filePath: viPath });
      const merged = mergeViSubtitlesByTimestamp(subtitles, viSubs);
      const map = buildExistingTranslationsMap(subtitles, merged);
      setTranslatedSubtitles(merged);
      setResumeTranslationsMap(map);
      pushTranslateLog(
        `Đã ghép bản dịch: ${Object.keys(map).length}/${subtitles.length} dòng. Còn ${countMissedLines(subtitles, merged)} dòng cần dịch sót.`
      );
      setActiveTab('translate');
    } catch (e: any) {
      pushTranslateLog(`Lỗi import bản dịch: ${e.message || e}`);
    }
  };

  const loadSrt = async (path: string) => {
    try {
      setTranslateStatus('Đang đọc file phụ đề...');
      const parsed = await apiPostJson<SubtitleItem[] | ParseSubtitlesLarge>(
        '/api/parse-subtitles',
        { filePath: path }
      );
      setSourceSrtPath(path);
      setTranslatedSrtOutputPath(null);
      setLargeTranslatedCount(0);
      setResumeTranslationsMap({});
      setViSrtPath(null);

      if (isLargeSrtResponse(parsed)) {
        setLargeSrtMode(true);
        setSubtitleLineCount(parsed.lineCount);
        setSubtitles([]);
        setTranslatedSubtitles([]);
        setTranslateStatus(
          `File lớn (${parsed.fileSizeLabel}, ${parsed.lineCount.toLocaleString()} dòng) — dịch trực tiếp trên server.`
        );
        setActiveTab('translate');
        return;
      }

      setLargeSrtMode(false);
      setSubtitleLineCount(parsed.length);
      setSubtitles(parsed);
      setTranslatedSubtitles(parsed.map((s) => ({ ...s, text: '' })));
      void analyzeSrtDuplicates(path);
      setActiveTab('translate');
    } catch (e: any) {
      alert(`Lỗi đọc file phụ đề: ${e.message || e}`);
    }
  };

  const loadViSrt = async (path: string) => {
    try {
      const parsedSubs = await apiPostJson<SubtitleItem[]>('/api/parse-subtitles', { filePath: path });
      const withText = parsedSubs.filter((s) => s.text?.trim());
      if (withText.length === 0) {
        alert('File SRT không có nội dung phụ đề hợp lệ.');
        return;
      }
      setViSrtPath(path);
      setSubtitles(parsedSubs.map((s) => ({ ...s, text: '' })));
      setTranslatedSubtitles(parsedSubs);
      setTranslateStatus(`Đã nạp ${withText.length} dòng phụ đề tiếng Việt — bỏ qua bước dịch, sẵn sàng lồng tiếng.`);
      setActiveTab('voice');
    } catch (e: any) {
      alert(`Lỗi đọc file phụ đề tiếng Việt: ${e.message || e}`);
    }
  };

  const loadVideo = async (path: string) => {
    setVideoPath(path);
    setOcrStatus("Đang đọc thông tin video...");
    try {
      const meta = await apiPostJson<{ duration: number; resolution: string; format: string }>(
        '/api/get-video-metadata',
        { videoPath: path }
      );
      setVideoMeta(meta);
      setOcrStatus("Đã tải video thành công. Hãy chọn khung quét phụ đề!");
    } catch (e: any) {
      setOcrStatus(`Lỗi đọc metadata: ${e.message || e}`);
    }
  };

  // 3. Start Python OCR process
  const handleStartOcr = async () => {
    if (!videoPath || isOcrRunning) return;
    setIsOcrRunning(true);
    setOcrProgress(0);
    setOcrStatus("Đang khởi động tiến trình OCR...");

    try {
      let srtFilePath = '';
      let ocrError: string | null = null;

      await apiPostSse('/api/start-ocr', {
        videoPath,
        xMin: cropCoords.xMin,
        yMin: cropCoords.yMin,
        xMax: cropCoords.xMax,
        yMax: cropCoords.yMax,
        ocrProfile,
        ocrDownscale720,
      }, (parsed) => {
        if (parsed.type === 'progress') {
          if (typeof parsed.progress === 'number') setOcrProgress(parsed.progress);
          if (typeof parsed.status === 'string') setOcrStatus(parsed.status);
        } else if (parsed.type === 'info' && typeof parsed.message === 'string') {
          setOcrStatus(parsed.message);
        } else if (parsed.type === 'done') {
          srtFilePath = (parsed.filePath ?? parsed.srt_path) as string;
        } else if (parsed.type === 'error') {
          ocrError = parsed.message as string;
        }
      });

      if (ocrError) throw new Error(ocrError);
      if (!srtFilePath) throw new Error('OCR không trả về file SRT');

      setOcrProgress(100);
      setOcrStatus("Trích xuất thành công! Đang đồng bộ hóa phụ đề...");

      setSourceSrtPath(srtFilePath);
      setTranslatedSrtOutputPath(null);
      setLargeTranslatedCount(0);

      const parsed = await apiPostJson<SubtitleItem[] | ParseSubtitlesLarge>(
        '/api/parse-subtitles',
        { filePath: srtFilePath }
      );

      if (isLargeSrtResponse(parsed)) {
        setLargeSrtMode(true);
        setSubtitleLineCount(parsed.lineCount);
        setSubtitles([]);
        setTranslatedSubtitles([]);
        setViSrtPath(null);
        setOcrStatus(
          `Hoàn tất OCR — file lớn (${parsed.fileSizeLabel}, ${parsed.lineCount.toLocaleString()} dòng). Sang tab Dịch để xử lý trên server.`
        );
        setActiveTab('translate');
        return;
      }

      setLargeSrtMode(false);
      setSubtitleLineCount(parsed.length);
      setSubtitles(parsed);
      setTranslatedSubtitles(parsed.map((s) => ({ ...s, text: '' })));
      setViSrtPath(null);
      void analyzeSrtDuplicates(srtFilePath);
      setOcrStatus(`Hoàn tất! Đã trích xuất được ${parsed.length} câu thoại.`);
      setActiveTab('translate'); // Auto switch to next phase
    } catch (e: any) {
      setOcrStatus(`Lỗi tiến trình OCR: ${e.message || e}`);
    } finally {
      setIsOcrRunning(false);
    }
  };

  const buildExistingTranslationsMapLocal = (): Record<number, string> => {
    if (largeSrtMode) return resumeTranslationsMap;
    return buildExistingTranslationsMap(subtitles, translatedSubtitles);
  };

  const applyBatchUpdates = (updates: { index: number; text: string }[]) => {
    setTranslatedSubtitles((prev) => {
      const next = [...prev];
      while (next.length < subtitles.length) {
        const i = next.length;
        next.push({ ...subtitles[i], text: '' });
      }
      for (const { index, text } of updates) {
        if (isValidTranslation(subtitles[index]?.text, text)) {
          next[index] = { ...subtitles[index], text };
        }
      }
      return next;
    });
  };

  const effectiveSubtitleCount = largeSrtMode ? subtitleLineCount : subtitles.length;

  const missedLineCount = largeSrtMode
    ? Math.max(0, subtitleLineCount - Object.keys(resumeTranslationsMap).length)
    : countMissedLines(subtitles, translatedSubtitles);

  const untranslatedCount = missedLineCount;
  const hasAnyTranslation = largeSrtMode
    ? Object.keys(resumeTranslationsMap).length > 0
    : countValidTranslations(subtitles, translatedSubtitles) > 0;
  const hasPartialTranslation = hasAnyTranslation && missedLineCount > 0;

  const quotaHint = (() => {
    if (untranslatedCount <= 0 || translateProvider !== 'gemini') return null;
    const avgChars = largeSrtMode
      ? 35
      : subtitles.reduce((s, sub) => s + sub.text.length, 0) / (subtitles.length || 1);
    const size = estimateBatchSize(
      largeSrtMode ? subtitleLineCount : subtitles.length,
      avgChars,
      translationBatchSize
    );
    const requestsNeeded = Math.ceil(untranslatedCount / size);
    const modelsCount = 3;
    const rpdPerModel = 20;
    const maxLinesDay = rpdPerModel * modelsCount * size;
    const keysCount = parseApiKeysFromText(geminiKeys, 'gemini').length;
    return {
      batchSize: size,
      requestsNeeded,
      maxLinesDay,
      keysCount,
      daysNeeded: Math.ceil(requestsNeeded / (rpdPerModel * modelsCount)),
    };
  })();
  const translatedLineCount = largeSrtMode
    ? Object.keys(resumeTranslationsMap).length || largeTranslatedCount
    : countValidTranslations(subtitles, translatedSubtitles);
  const hasDubbingSubtitles = translatedLineCount > 0;

  const buildTranslatedSrtContent = (): string => {
    return subtitles
      .map((sub, i) => {
        const text = isValidTranslation(sub.text, translatedSubtitles[i]?.text)
          ? translatedSubtitles[i].text.trim()
          : '';
        return `${sub.id}\n${sub.start} --> ${sub.end}\n${text}\n`;
      })
      .join('\n');
  };

  const getTranslatedSrtFilename = (): string => {
    const baseName =
      videoPath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/i, '') || 'subtitles';
    const suffix =
      hasPartialTranslation && untranslatedCount > 0 ? '_vi_partial' : '_vi';
    return `${baseName}${suffix}.srt`;
  };

  const getExtractedSrtFilename = (): string => {
    const baseName =
      videoPath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/i, '') || 'subtitles';
    return `${baseName}_zh.srt`;
  };

  const buildSourceSrtContent = (): string => {
    return subtitles
      .map((sub) => `${sub.id}\n${sub.start} --> ${sub.end}\n${sub.text}\n`)
      .join('\n');
  };

  const extractedSubtitleCount = largeSrtMode ? subtitleLineCount : subtitles.length;

  const handleDownloadExtractedSrt = () => {
    const filename = getExtractedSrtFilename();

    if (sourceSrtPath) {
      const link = document.createElement('a');
      link.href = apiUrl(
        `/api/download-file?path=${encodeURIComponent(sourceSrtPath)}`
      );
      link.download = filename;
      link.click();
      setOcrStatus(
        `Đã tải xuống ${filename} (${extractedSubtitleCount.toLocaleString()} dòng)`
      );
      return;
    }

    if (subtitles.length > 0) {
      const content = buildSourceSrtContent();
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setOcrStatus(`Đã tải xuống ${filename} (${subtitles.length} dòng)`);
      return;
    }

    setOcrStatus('Chưa có file SRT đã trích xuất để tải về.');
  };

  const duplicateIndexSet = useMemo(() => {
    const s = new Set<number>();
    for (const p of duplicatePairs) {
      s.add(p.indexA);
      s.add(p.indexB);
    }
    return s;
  }, [duplicatePairs]);

  const analyzeSrtDuplicates = useCallback(async (filePath: string) => {
    try {
      const result = await apiPostJson<{
        duplicatePairs?: typeof duplicatePairs;
        duplicateCount?: number;
      }>('/api/analyze-srt-duplicates', { filePath });
      setDuplicatePairs(result.duplicatePairs ?? []);
    } catch {
      setDuplicatePairs([]);
    }
  }, []);

  const handleCleanupSrt = async () => {
    if (!sourceSrtPath) {
      setOcrStatus('Chỉ gộp/lọc được file SRT đã lưu trên máy (sau OCR hoặc import SRT).');
      return;
    }
    setIsCleaningSrt(true);
    try {
      const result = await apiPostJson<{
        before: number;
        after: number;
        merged: number;
        subtitles: SubtitleItem[];
        duplicatePairs?: typeof duplicatePairs;
        duplicateCount?: number;
        remainingDuplicates?: number;
      }>('/api/cleanup-srt', { filePath: sourceSrtPath });
      setSubtitles(result.subtitles);
      setSubtitleLineCount(result.subtitles.length);
      setLargeSrtMode(false);
      setActiveSubtitleIndex(-1);
      setDuplicatePairs([]);
      void analyzeSrtDuplicates(sourceSrtPath);
      const kept =
        result.before > 0
          ? Math.round((result.after / result.before) * 100)
          : 100;
      setOcrStatus(
        `Đã lọc SRT: ${result.before} → ${result.after} dòng (giữ ~${kept}%). ` +
          `Chuẩn ~334 dòng/0531 (2).srt: SRT tay gần như giữ nguyên; OCR gộp theo mục tiêu đó. ` +
          `Trước: ${result.duplicateCount ?? 0} cặp cần gộp; còn ${result.remainingDuplicates ?? 0}.`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setOcrStatus(`Lỗi lọc SRT: ${msg}`);
    } finally {
      setIsCleaningSrt(false);
    }
  };

  const handleDownloadTranslatedSrt = async () => {
    if (translatedSrtOutputPath) {
      const filename = getTranslatedSrtFilename();
      const url = apiUrl(
        `/api/download-file?path=${encodeURIComponent(translatedSrtOutputPath)}`
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTranslateStatus(`Đã tải xuống ${filename} (${translatedLineCount.toLocaleString()} dòng)`);
      return;
    }

    const content = buildTranslatedSrtContent();
    if (!content.trim()) {
      setTranslateStatus('Chưa có dòng phụ đề đã dịch để tải về.');
      return;
    }

    const filename = getTranslatedSrtFilename();

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setTranslateStatus(`Đã tải xuống ${filename} (${translatedLineCount} dòng)`);
  };

  // 4. Translate SRT with Gemini Rotation Key Pool (resume-aware)
  const handleTranslateSrt = async () => {
    if ((subtitles.length === 0 && !largeSrtMode) || isTranslateRunning) return;

    const isOpenRouter = translateProvider === 'openrouter';
    const keysArray = parseApiKeysFromText(
      isOpenRouter ? openRouterKeys : geminiKeys,
      translateProvider
    );

    if (keysArray.length === 0) {
      pushTranslateLog(
        isOpenRouter
          ? 'LỖI: Vui lòng nhập ít nhất một OpenRouter API Key (sk-or-v1-...)!'
          : 'LỖI: Vui lòng nhập ít nhất một Gemini API Key!'
      );
      return;
    }

    if (isOpenRouter) {
      const validOrKeys = keysArray.filter(isValidOpenRouterApiKey);
      if (validOrKeys.length === 0) {
        pushTranslateLog(
          'LỖI: OpenRouter key phải bắt đầu sk-or-v1-... (một key dài được gộp tự động nếu bị xuống dòng trong ô nhập).'
        );
        return;
      }
      if (validOrKeys.length < keysArray.length) {
        pushTranslateLog(
          `Cảnh báo: Bỏ qua ${keysArray.length - validOrKeys.length} đoạn không phải key OpenRouter.`
        );
      }
    } else {
      const validGeminiKeys = keysArray.filter(isValidGeminiApiKey);
      if (validGeminiKeys.length === 0) {
        pushTranslateLog(
          'LỖI: API key Gemini không hợp lệ. Key từ AI Studio thường bắt đầu bằng AIzaSy... hoặc AQ.... (aistudio.google.com/apikey).'
        );
        return;
      }
      if (validGeminiKeys.length < keysArray.length) {
        pushTranslateLog(
          `Cảnh báo: Bỏ qua ${keysArray.length - validGeminiKeys.length} đoạn không phải API key Gemini.`
        );
      }
    }

    if (isOpenRouter && !openRouterModel.trim()) {
      pushTranslateLog('LỖI: Vui lòng chọn model OpenRouter!');
      return;
    }

    const existingTranslations = buildExistingTranslationsMapLocal();
    const alreadyDone = Object.keys(existingTranslations).length;
    const totalLines = effectiveSubtitleCount;
    const remaining = totalLines - alreadyDone;

    setIsTranslateRunning(true);
    if (alreadyDone > 0) {
      pushTranslateLog(
        `Tiếp tục dịch: đã có ${alreadyDone}/${totalLines} dòng, còn ${remaining} dòng...`,
        Math.round((alreadyDone / totalLines) * 100)
      );
    } else {
      pushTranslateLog(
        largeSrtMode
          ? `File lớn (${totalLines.toLocaleString()} dòng) — đang kết nối server...`
          : 'Đang kiểm tra server và bắt đầu dịch...',
        0
      );
    }

    try {
      await apiGetJson<{ ok: boolean }>('/api/health');
      pushTranslateLog('Server OK — đang gửi yêu cầu dịch...', translateProgress);
    } catch (e: any) {
      pushTranslateLog(
        `Lỗi: Backend không chạy (${e.message || e}). Mở terminal và chạy: npm.cmd run dev`
      );
      setIsTranslateRunning(false);
      return;
    }

    const srtLines = subtitles
      .map((sub, i) => `${i + 1}\n${sub.start} --> ${sub.end}\n${sub.text}\n`)
      .join('\n');

    const geminiKeysForApi = isOpenRouter
      ? keysArray.filter(isValidOpenRouterApiKey)
      : keysArray.filter(isValidGeminiApiKey);

    const translatePayload: Record<string, unknown> = {
      apiKeys: geminiKeysForApi,
      existingTranslations,
      provider: translateProvider,
      model: isOpenRouter ? openRouterModel : undefined,
      batchSize: translationBatchSize > 0 ? translationBatchSize : undefined,
    };

    if (largeSrtMode) {
      if (!sourceSrtPath?.trim()) {
        pushTranslateLog('Lỗi: Mất đường dẫn file SRT. Vui lòng import lại file (không refresh trang).');
        setIsTranslateRunning(false);
        return;
      }
      translatePayload.filePath = sourceSrtPath;
    } else if (subtitles.length > 0 && srtLines.trim()) {
      translatePayload.srtContent = srtLines;
    } else if (sourceSrtPath?.trim()) {
      translatePayload.filePath = sourceSrtPath;
    } else {
      pushTranslateLog('Lỗi: Không có nội dung phụ đề để dịch — import file SRT trước.');
      setIsTranslateRunning(false);
      return;
    }

    const processSsePart = (parsed: {
      type: string;
      progress?: number;
      log?: string;
      updates?: { index: number; text: string }[];
      content?: string;
      outputFilePath?: string;
      partial?: boolean;
      translatedCount?: number;
      totalCount?: number;
      message?: string;
      recoverable?: boolean;
    }) => {
      if (parsed.type === 'progress') {
        pushTranslateLog(parsed.log ?? 'Đang dịch...', parsed.progress ?? translateProgress);
      } else if (parsed.type === 'batch' && parsed.updates) {
        applyBatchUpdates(parsed.updates);
      } else if (parsed.type === 'done' && (parsed.content || parsed.outputFilePath)) {
        return {
          done: true,
          content: parsed.content,
          outputFilePath: parsed.outputFilePath,
          partial: parsed.partial,
          translatedCount: parsed.translatedCount,
        };
      } else if (parsed.type === 'error') {
        return { error: parsed.message, recoverable: parsed.recoverable };
      }
      return null;
    };

    try {
      let translatedSrtContent = '';
      let outputFilePath: string | undefined;
      let isPartial = false;
      let translatedCountFromApi = alreadyDone;
      let recoverableError: string | null = null;

      await apiPostSse('/api/translate-srt', translatePayload, (parsed) => {
        const result = processSsePart(parsed as Parameters<typeof processSsePart>[0]);
        if (result?.done) {
          translatedSrtContent = result.content ?? '';
          outputFilePath = result.outputFilePath;
          isPartial = Boolean(result.partial);
          if (result.translatedCount != null) {
            translatedCountFromApi = result.translatedCount;
          }
        } else if (result?.error) {
          if (result.recoverable) {
            recoverableError = result.error;
          } else {
            throw new Error(result.error);
          }
        }
      });

      if (recoverableError && !translatedSrtContent && !outputFilePath) {
        throw new Error(recoverableError);
      }
      if (recoverableError) {
        isPartial = true;
        pushTranslateLog(recoverableError, Math.round((translatedCountFromApi / totalLines) * 100));
      }

      if (outputFilePath) {
        setTranslatedSrtOutputPath(outputFilePath);
        setLargeTranslatedCount(translatedCountFromApi);
        if (largeSrtMode) {
          pushTranslateLog(
            `Đã dịch ${translatedCountFromApi}/${totalLines} dòng. Tải file về, sau đó "Import bản dịch" để lần sau tiếp tục dịch sót.`,
            Math.round((translatedCountFromApi / totalLines) * 100)
          );
        }
      } else if (translatedSrtContent) {
        const parsed = parseSrtText(translatedSrtContent);
        setTranslatedSubtitles((prev) => {
          const next = [...prev];
          while (next.length < subtitles.length) {
            const i = next.length;
            next.push({ ...subtitles[i], text: '' });
          }
          parsed.forEach((item, i) => {
            if (isValidTranslation(subtitles[i]?.text, item.text)) {
              next[i] = { ...subtitles[i], text: item.text };
            }
          });
          const map = buildExistingTranslationsMap(subtitles, next);
          setResumeTranslationsMap(map);
          setLargeTranslatedCount(Object.keys(map).length);
          return next;
        });
      }

      if (isPartial) {
        return;
      }

      pushTranslateLog(
        largeSrtMode
          ? `Hoàn thành! Đã dịch ${totalLines.toLocaleString()} dòng — bấm "Tải SRT đã dịch".`
          : `Hoàn thành! Đã dịch ${subtitles.length} câu thoại.`,
        100
      );
      if (!largeSrtMode) {
        setActiveTab('voice');
      }
    } catch (e: any) {
      pushTranslateLog(`Lỗi dịch thuật: ${e.message || e}`, translateProgress);
    } finally {
      setIsTranslateRunning(false);
    }
  };

  const parseSrtText = (content: string): SubtitleItem[] => {
    if (!content?.trim()) return [];
    const srtRegex = /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|\r?\n$|$)/g;
    const matches = [...content.matchAll(srtRegex)];
    return matches.map(m => ({
      id: m[1],
      start: m[2],
      end: m[3],
      text: m[4].replace(/\r?\n/g, ' ').trim()
    }));
  };

  // 5. Synthesize TTS and Render Dubbing Mix
  const handleStartDubbing = async () => {
    if (!videoPath || !hasDubbingSubtitles || isRenderRunning) return;

    const defaultOut = `dubbed_${videoPath.split(/[\\/]/).pop() || 'output.mp4'}`;
    const outPath = window.prompt(
      'Nhập đường dẫn lưu file video kết quả (Ví dụ: D:\\video\\dubbed_output.mp4):',
      `D:\\video\\${defaultOut}`
    );
    if (!outPath) return;

    setIsRenderRunning(true);
    setRenderProgress(0);
    setRenderStatus("Đang chuẩn bị lõi lồng tiếng...");

    try {
      const dubSubtitles = translatedSubtitles.map(s => ({ ...s, text: s.text || subtitles.find(o => o.id === s.id)?.text || '' }));

      let renderFailed: string | null = null;

      await apiPostSse('/api/start-rendering', {
        videoPath,
        subtitles: dubSubtitles,
        voiceSettings,
        mixing: {
          keepOriginal: keepOriginalAudio,
          ai: mixing.ai,
          bg: mixing.bg,
          voice: mixing.voice,
        },
        mode: dubbingMode,
        outputPath: outPath,
        apiKeys: {
          google: googleKey,
          openai: openaiKey,
          elevenlabs: elevenlabsKey,
        },
      }, (parsed) => {
        if (parsed.type === 'progress') {
          setRenderProgress(Math.round((parsed.progress as number) * 100));
          setRenderStatus(parsed.log as string);
        } else if (parsed.type === 'error') {
          renderFailed = parsed.message as string;
        }
      });

      if (renderFailed) {
        throw new Error(renderFailed);
      }

      setRenderProgress(100);
      setRenderStatus("Kết xuất hoàn tất!");
      setRenderedVideoPath(outPath);
    } catch (e: any) {
      setRenderStatus(`Lỗi kết xuất: ${e.message || e}`);
    } finally {
      setIsRenderRunning(false);
    }
  };

  const updateVoiceSetting = (idx: number, key: string, val: any) => {
    const newSettings = [...voiceSettings];
    newSettings[idx] = { ...newSettings[idx], [key]: val };
    setVoiceSettings(newSettings);
  };

  return (
    <div className="flex min-h-screen bg-deep-space text-white">
      {/* Sidebar Navigation */}
      <aside className="w-80 border-r border-white/5 bg-black/40 backdrop-blur-xl flex flex-col p-6 gap-8">
        <div className="flex flex-col gap-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[10px] font-bold tracking-wider w-fit">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400"></span>
            </span>
            VIBE SUBTITLE локаlizer
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white mt-1 text-cyan-glow">
            Vibe Studio
          </h1>
          <p className="text-xs text-gray-500 font-medium">
            AI Subtitle Extractor & Hybrid Dubber
          </p>
        </div>

        {/* Tab Buttons */}
        <nav className="flex flex-col gap-2.5">
          <button
            onClick={() => setActiveTab('ocr')}
            className={`w-full h-12 rounded-xl flex items-center px-4 gap-3 text-xs font-bold transition-all ${
              activeTab === 'ocr'
                ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.15)]'
                : 'hover:bg-white/5 border border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Film className="w-4 h-4" />
            <span>1. Trích xuất OCR Video</span>
          </button>

          <button
            onClick={() => setActiveTab('translate')}
            className={`w-full h-12 rounded-xl flex items-center px-4 gap-3 text-xs font-bold transition-all ${
              activeTab === 'translate'
                ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.15)]'
                : 'hover:bg-white/5 border border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Cpu className="w-4 h-4" />
            <span>2. Dịch thuật AI (Rotation)</span>
          </button>

          <button
            onClick={() => setActiveTab('voice')}
            className={`w-full h-12 rounded-xl flex items-center px-4 gap-3 text-xs font-bold transition-all ${
              activeTab === 'voice'
                ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.15)]'
                : 'hover:bg-white/5 border border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>3. Cấu hình Lồng tiếng</span>
          </button>

          <button
            onClick={() => setActiveTab('mix')}
            className={`w-full h-12 rounded-xl flex items-center px-4 gap-3 text-xs font-bold transition-all ${
              activeTab === 'mix'
                ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.15)]'
                : 'hover:bg-white/5 border border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Volume2 className="w-4 h-4" />
            <span>4. Trộn âm & Kết xuất</span>
          </button>
        </nav>

        {/* Sidebar Info/Metadata Panel */}
        <div className="mt-auto glass-panel p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-cyan-400 text-xs font-bold">
            <Settings className="w-3.5 h-3.5" />
            <span>Thông tin tiến trình</span>
          </div>
          <div className="flex flex-col gap-1.5 font-mono text-[10px] text-gray-400 border-t border-white/5 pt-2">
            <div className="flex justify-between">
              <span>Video:</span>
              <span className="text-white truncate max-w-[150px]">
                {videoPath ? videoPath.split(/[\\/]/).pop() : 'Chưa tải'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Độ phân giải:</span>
              <span className="text-white">{videoMeta?.resolution || 'N/A'}</span>
            </div>
            <div className="flex justify-between">
              <span>Thời lượng:</span>
              <span className="text-white">
                {videoMeta ? `${videoMeta.duration.toFixed(2)}s` : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Phụ đề gốc:</span>
              <span className="text-white font-bold">
                {effectiveSubtitleCount.toLocaleString()} dòng
                {largeSrtMode && <span className="text-amber-400 ml-1">(file lớn)</span>}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Phụ đề VI:</span>
              <span className={`font-bold ${hasDubbingSubtitles ? 'text-emerald-400' : 'text-white'}`}>
                {hasDubbingSubtitles ? `${translatedLineCount} dòng sẵn sàng` : 'Chưa có'}
              </span>
            </div>
            {viSrtPath && (
              <div className="flex justify-between">
                <span>SRT VI:</span>
                <span className="text-emerald-400 truncate max-w-[150px]" title={viSrtPath}>
                  {viSrtPath.split(/[\\/]/).pop()}
                </span>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Panel Content */}
      <main className="flex-1 p-8 overflow-y-auto custom-scrollbar">
        {/* --- TAB 1: OCR --- */}
        {activeTab === 'ocr' && (
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-black tracking-tight">Trích xuất Phụ đề OCR</h2>
                <p className="text-xs text-gray-500">
                  <b>Quét</b> khung hình liên tục, chỉ <b>OCR</b> khi vùng chữ đổi (ít ảnh hơn, nhanh hơn). Mỗi lần đổi nội dung = 1 dòng SRT.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-end">
                <button
                  onClick={handleImportViSrt}
                  className="h-10 px-5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500 hover:text-black font-bold text-xs flex items-center gap-2 transition-all text-emerald-300"
                >
                  <FileText className="w-4 h-4" /> Import SRT Tiếng Việt
                </button>
                <button
                  onClick={handleImportSrt}
                  className="h-10 px-5 rounded-xl bg-white/5 border border-white/10 hover:bg-purple-500 hover:text-white font-bold text-xs flex items-center gap-2 transition-all"
                >
                  <FileText className="w-4 h-4" /> Import SRT Gốc (cần dịch)
                </button>
                <button
                  onClick={handleImportVideo}
                  className="h-10 px-5 rounded-xl bg-white/5 border border-white/10 hover:bg-cyan-500 hover:text-black font-bold text-xs flex items-center gap-2 transition-all"
                >
                  <Upload className="w-4 h-4" /> Import Video MP4
                </button>
              </div>
            </div>

            {hasDubbingSubtitles && viSrtPath && (
              <div className="glass-panel p-4 border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-200">
                <p className="font-bold text-emerald-300 mb-1">SRT tiếng Việt đã nạp — bỏ qua bước dịch</p>
                <p className="text-emerald-200/80">
                  {translatedLineCount} dòng sẵn sàng lồng tiếng. Chuyển sang tab <b>3. Cấu hình Lồng tiếng</b> hoặc <b>4. Kết xuất</b>.
                </p>
              </div>
            )}

            <div className="dashboard-grid">
              {/* Left Side: Video Player & Bounding box */}
              <div className="glass-panel p-6 flex flex-col gap-4">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-gray-400">Trình phát & Khung quét phụ đề</span>
                  <span className="text-[10px] bg-cyan-500/10 text-cyan-400 px-1.5 py-0.5 rounded font-mono">
                    COORD: [{cropCoords.xMin.toFixed(2)}, {cropCoords.yMin.toFixed(2)}, {cropCoords.xMax.toFixed(2)}, {cropCoords.yMax.toFixed(2)}]
                  </span>
                </div>

                <div className="aspect-video bg-black/80 rounded-2xl border border-white/5 overflow-hidden relative flex items-center justify-center group">
                  {videoPath ? (
                    <div className="w-full h-full relative">
                      <video
                        ref={videoRef}
                        src={apiUrl(`/api/stream-video?path=${encodeURIComponent(videoPath)}`)}
                        className="w-full h-full object-contain"
                        controls
                      />
                      <SubtitleVideoOverlay
                        subtitles={subtitles}
                        videoRef={videoRef}
                        enabled={showSubtitleOnVideo && subtitles.length > 0}
                        activeIndex={activeSubtitleIndex}
                        onActiveIndexChange={setActiveSubtitleIndex}
                      />
                      <SubtitleCropbox onChange={setCropCoords} />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-center p-12">
                      <div className="p-4 bg-white/5 rounded-full border border-white/5">
                        <Film className="w-10 h-10 text-gray-600" />
                      </div>
                      <p className="text-xs text-gray-500">Chưa tải video. Hãy nhấn nút Import Video để bắt đầu.</p>
                    </div>
                  )}
                </div>

                {ocrEngine && ocrRuntimeReady && (
                  <div className="text-[10px] text-cyan-200/90 bg-cyan-500/10 border border-cyan-500/25 rounded-lg px-3 py-2 leading-relaxed">
                    Engine OCR: <b>{ocrEngine === 'paddle' ? 'PaddleOCR' : 'EasyOCR'}</b> (Python 3.12)
                    {ocrEngineMessage ? (
                      <span className="block mt-0.5 text-gray-400 font-normal">{ocrEngineMessage}</span>
                    ) : null}
                  </div>
                )}
                {ocrRuntimeReady === false && (
                  <div className="text-[10px] text-red-200 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 leading-relaxed">
                    <b>Chưa cài OCR trên Python 3.12</b>. Trong terminal:
                    <code className="block mt-1 text-red-100">
                      powershell -ExecutionPolicy Bypass -File scripts\setup-paddleocr.ps1
                    </code>
                  </div>
                )}

                {videoPath && !isOcrRunning && (
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase">Chế độ trích xuất OCR</label>
                    <select
                      value={ocrProfile}
                      onChange={(e) => setOcrProfile(e.target.value as 'accurate' | 'balanced' | 'fast')}
                      className="h-9 rounded-lg bg-black/40 border border-white/10 text-xs px-3 text-cyan-100"
                    >
                      <option value="accurate">Chính xác — gần file chuẩn, tốc độ vừa (khuyên dùng)</option>
                      <option value="balanced">Cân bằng — nhanh hơn</option>
                      <option value="fast">Nhanh — video dài, có thể thiếu vài câu</option>
                    </select>
                    <label className="flex items-center gap-2 text-[10px] text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ocrDownscale720}
                        onChange={(e) => setOcrDownscale720(e.target.checked)}
                        className="rounded border-white/20"
                      />
                      Tự giảm video xuống <b className="text-cyan-300">720p</b> khi quét (nhanh hơn với 1080p/4K)
                    </label>
                    <p className="text-[10px] text-amber-200/90 leading-relaxed">
                      Khung cyan <b>chỉ một dòng</b> phụ đề. Sau OCR tự <b>gộp</b> dòng trùng (xem log &quot;đã gộp X dòng&quot;).
                    </p>
                    {subtitles.length > 0 && (
                      <label className="flex items-center gap-2 text-[10px] text-gray-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showSubtitleOnVideo}
                          onChange={(e) => setShowSubtitleOnVideo(e.target.checked)}
                          className="rounded border-white/20"
                        />
                        Hiển thị phụ đề đã trích xuất trên video (timeline + chữ)
                      </label>
                    )}
                  </div>
                )}

                {videoPath && (
                  <button
                    onClick={handleStartOcr}
                    disabled={isOcrRunning}
                    className="w-full h-12 rounded-xl bg-cyan-500 text-black font-black text-xs flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(6,182,212,0.4)] hover:bg-white transition-all disabled:opacity-50 disabled:grayscale cyan-glow"
                  >
                    {isOcrRunning ? (
                      <>
                        <Loader className="w-4 h-4 animate-spin" />
                        <span>ĐANG QUÉT PHỤ ĐỀ OCR ({ocrProgress}%)</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 fill-black" />
                        <span>BẮT ĐẦU TRÍCH XUẤT PHỤ ĐỀ</span>
                      </>
                    )}
                  </button>
                )}

                {/* Progress bar / Logger */}
                {isOcrRunning && (
                  <div className="flex flex-col gap-2 p-4 rounded-xl bg-black/40 border border-cyan-500/20 font-mono text-[10px]">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Trạng thái:</span>
                      <span className="text-cyan-400 font-bold">{ocrStatus}</span>
                    </div>
                    <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-cyan-500 shadow-[0_0_8px_var(--neon-cyan)] transition-all duration-300"
                        style={{ width: `${ocrProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Visual Status Indicator for Loaded Video */}
                {videoPath && !isOcrRunning && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold animate-fadeIn">
                      <CheckCircle className="w-5 h-5 shrink-0 animate-pulse text-emerald-400" />
                      <div className="flex-1">
                        <p className="font-black uppercase tracking-wider">Đã tải video thành công!</p>
                        <p className="text-[10px] text-emerald-400/80 font-normal mt-0.5">
                          {ocrStatus}
                        </p>
                      </div>
                    </div>
                    {(sourceSrtPath || subtitles.length > 0) && (
                      <button
                        type="button"
                        onClick={handleDownloadExtractedSrt}
                        className="w-full h-10 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-cyan-500/20 transition-all"
                      >
                        <Download className="w-4 h-4" />
                        Tải SRT đã trích xuất (.srt)
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Right Side: Subtitles Editor Table */}
              <div className="glass-panel p-6 flex flex-col gap-4">
                <div className="flex justify-between items-center gap-2 flex-wrap">
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                      Danh sách phụ đề gốc ({extractedSubtitleCount.toLocaleString()})
                    </h3>
                    {duplicatePairs.length > 0 && (
                      <p className="text-[10px] text-amber-300/90">
                        {duplicatePairs.length} cặp cần gộp (trùng / mảnh OCR) — viền vàng.「Gộp / lọc」áp dụng cho mọi file SRT đang mở, ghi đè file gốc.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {sourceSrtPath && subtitles.length > 0 && !largeSrtMode && (
                      <button
                        type="button"
                        onClick={handleCleanupSrt}
                        disabled={isCleaningSrt}
                        className="h-8 px-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 hover:bg-amber-500/20 transition-all disabled:opacity-50"
                      >
                        {isCleaningSrt ? 'Đang lọc…' : 'Gộp / lọc trùng SRT'}
                      </button>
                    )}
                    {(sourceSrtPath || subtitles.length > 0) && (
                      <button
                        type="button"
                        onClick={handleDownloadExtractedSrt}
                        className="h-8 px-3 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 hover:bg-cyan-500/20 transition-all"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Tải SRT đã trích xuất
                      </button>
                    )}
                  </div>
                </div>

                <div
                  ref={subtitleListRef}
                  className="h-[400px] border border-white/5 bg-black/20 rounded-xl overflow-y-auto p-4 flex flex-col gap-2 custom-scrollbar"
                >
                  {subtitles.length > 0 ? (
                    subtitles.map((sub, idx) => (
                      <div
                        key={sub.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          const t = srtTimestampToSeconds(sub.start);
                          if (videoRef.current) {
                            videoRef.current.currentTime = t;
                            void videoRef.current.play().catch(() => undefined);
                          }
                          setActiveSubtitleIndex(idx);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            const t = srtTimestampToSeconds(sub.start);
                            if (videoRef.current) videoRef.current.currentTime = t;
                            setActiveSubtitleIndex(idx);
                          }
                        }}
                        data-sub-idx={idx}
                        className={`p-3 rounded-lg border flex flex-col gap-1 transition-all cursor-pointer ${
                          idx === activeSubtitleIndex
                            ? 'border-cyan-400/60 bg-cyan-500/15 ring-1 ring-cyan-500/30'
                            : duplicateIndexSet.has(idx)
                              ? 'border-amber-400/50 bg-amber-500/10 hover:border-amber-400/60'
                              : 'border-white/5 bg-white/5 hover:border-cyan-500/30'
                        }`}
                      >
                        <div className="flex justify-between items-center text-[10px] font-mono text-cyan-400">
                          <span>#{sub.id}</span>
                          <span>{sub.start} → {sub.end}</span>
                        </div>
                        <input
                          type="text"
                          value={sub.text}
                          onChange={(e) => {
                            const newSubs = [...subtitles];
                            const targetIdx = newSubs.findIndex(s => s.id === sub.id);
                            newSubs[targetIdx].text = e.target.value;
                            setSubtitles(newSubs);
                          }}
                          className="bg-transparent border-none text-xs text-white focus:outline-none focus:ring-0 w-full"
                        />
                      </div>
                    ))
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-gray-600">
                      Chưa trích xuất phụ đề nào
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 2: AI TRANSLATOR --- */}
        {activeTab === 'translate' && (
          <div className="flex flex-col gap-6">
            {largeSrtMode && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                File SRT lớn ({subtitleLineCount.toLocaleString()} dòng) — app dịch trực tiếp trên server, không tải hết vào trình duyệt.
                Sau khi dịch xong, bấm <b>Tải SRT đã dịch</b> để lưu file.
              </div>
            )}
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-black tracking-tight">Dịch thuật AI & Khử rate limit</h2>
                <p className="text-xs text-gray-500">
                  Chọn Gemini trực tiếp hoặc OpenRouter với nhiều model AI khác nhau
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDownloadTranslatedSrt}
                  disabled={translatedLineCount === 0 || isTranslateRunning}
                  className="h-10 px-5 rounded-xl bg-white/5 border border-white/10 hover:bg-emerald-500 hover:text-white font-bold text-xs flex items-center gap-2 transition-all disabled:opacity-40 disabled:pointer-events-none"
                  title={
                    hasPartialTranslation && untranslatedCount > 0
                      ? `Tải ${translatedLineCount} dòng đã dịch (còn ${untranslatedCount} dòng chưa dịch)`
                      : 'Tải file SRT tiếng Việt'
                  }
                >
                  <Download className="w-4 h-4" /> Tải SRT đã dịch
                  {translatedLineCount > 0 && (
                    <span className="opacity-70">({translatedLineCount})</span>
                  )}
                </button>
                <button
                  onClick={handleImportViSrt}
                  className="h-10 px-5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500 hover:text-black font-bold text-xs flex items-center gap-2 transition-all text-emerald-300"
                >
                  <FileText className="w-4 h-4" /> Import SRT Tiếng Việt
                </button>
                <button
                  onClick={handleImportSrt}
                  className="h-10 px-5 rounded-xl bg-white/5 border border-white/10 hover:bg-purple-500 hover:text-white font-bold text-xs flex items-center gap-2 transition-all"
                >
                  <FileText className="w-4 h-4" /> Import SRT Gốc
                </button>
              </div>
            </div>

            {hasDubbingSubtitles && viSrtPath && (
              <div className="glass-panel p-4 border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-200">
                Đã import SRT tiếng Việt ({translatedLineCount} dòng) — có thể bỏ qua dịch AI, sang tab Lồng tiếng / Kết xuất.
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Configuration panel */}
              <div className="glass-panel p-6 flex flex-col gap-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Cấu hình dịch thuật</h3>

                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 px-1">
                    Nguồn AI
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setTranslateProvider('gemini')}
                      className={`h-10 rounded-xl border text-xs font-bold transition-all ${
                        translateProvider === 'gemini'
                          ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                          : 'bg-white/5 border-white/10 text-gray-400 hover:border-white/20'
                      }`}
                    >
                      Gemini (Google)
                    </button>
                    <button
                      type="button"
                      onClick={() => setTranslateProvider('openrouter')}
                      className={`h-10 rounded-xl border text-xs font-bold transition-all ${
                        translateProvider === 'openrouter'
                          ? 'bg-purple-500/20 border-purple-500 text-purple-300'
                          : 'bg-white/5 border-white/10 text-gray-400 hover:border-white/20'
                      }`}
                    >
                      OpenRouter
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 px-1">
                    Batch size (dòng / request)
                  </label>
                  <select
                    value={translationBatchSize}
                    onChange={(e) => setTranslationBatchSize(Number(e.target.value))}
                    className="w-full h-10 px-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white focus:outline-none focus:border-cyan-500"
                  >
                    {TRANSLATION_BATCH_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} className="bg-gray-900">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-gray-500 leading-relaxed px-1">
                    Batch lớn = ít request hơn, nhanh hơn với file lớn. Nếu lỗi hoặc thiếu dòng dịch, hạ xuống 80–120.
                  </p>
                </div>

                {translateProvider === 'openrouter' && (
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 px-1">
                      Model OpenRouter
                    </label>
                    <select
                      value={openRouterModel}
                      onChange={(e) => setOpenRouterModel(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white focus:outline-none focus:border-purple-500"
                    >
                      {OPENROUTER_MODELS.map((m) => (
                        <option key={m.id} value={m.id} className="bg-gray-900">
                          {m.name}{m.free ? ' · Free' : ''}{m.description ? ` — ${m.description}` : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] text-gray-500 leading-relaxed px-1">
                      Lấy API key tại{' '}
                      <a
                        href="https://openrouter.ai/keys"
                        target="_blank"
                        rel="noreferrer"
                        className="text-purple-400 hover:underline"
                      >
                        openrouter.ai/keys
                      </a>
                      . Model free có thể chậm hoặc giới hạn RPM.
                    </p>
                  </div>
                )}
                
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 px-1">
                    {translateProvider === 'openrouter'
                      ? 'OpenRouter API Key'
                      : 'Danh sách Gemini API Keys'}
                  </label>
                  <textarea
                    rows={translateProvider === 'openrouter' ? 3 : 8}
                    wrap="off"
                    value={translateProvider === 'openrouter' ? openRouterKeys : geminiKeys}
                    onChange={(e) =>
                      translateProvider === 'openrouter'
                        ? setOpenRouterKeys(e.target.value)
                        : setGeminiKeys(e.target.value)
                    }
                    placeholder={
                      translateProvider === 'openrouter'
                        ? 'sk-or-v1-... (dán 1 key, kéo ngang nếu dài; Enter chỉ khi có key thứ 2)'
                        : 'AIzaSy... hoặc AQ.... (mỗi dòng 1 key — Enter để key mới)'
                    }
                    className="w-full p-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-gray-600 font-mono focus:outline-none focus:border-cyan-500 overflow-x-auto whitespace-pre overflow-y-auto resize-y"
                    style={{ wordBreak: 'normal', overflowWrap: 'normal' }}
                  />
                  <p className="text-[10px] text-gray-500 leading-relaxed px-1">
                    💡 Key dài bị xuống dòng trong ô vẫn được <b>gộp thành 1 key</b>. Chỉ bấm <b>Enter</b> khi muốn thêm key thứ 2. Nếu lỗi, xem nhật ký bên dưới.
                  </p>
                  {translateProvider === 'openrouter' && (
                    <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/30 text-[10px] text-purple-200/90 leading-relaxed space-y-1">
                      <p className="font-bold text-purple-300">OpenRouter</p>
                      <p>
                        Model đang chọn: <b>{OPENROUTER_MODELS.find((m) => m.id === openRouterModel)?.name ?? openRouterModel}</b>
                      </p>
                      <p>
                        OpenRouter gom nhiều model (Gemini, DeepSeek, Qwen, Claude...) qua một API key. Trả phí theo usage hoặc dùng model free.
                      </p>
                    </div>
                  )}
                  {quotaHint && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-200/90 leading-relaxed space-y-1">
                      <p className="font-bold text-amber-300">⚠️ Giới hạn Gemini Free (quan trọng)</p>
                      <p>
                        <b>10 RPM</b> = tối đa 10 request/phút. <b>20 RPD</b> = chỉ <b>20 request/ngày</b> cho mỗi model (ảnh dashboard: 19/20).
                      </p>
                      <p>
                        Mỗi lần dịch ≈ <b>1 request</b> (~{quotaHint.batchSize} dòng/batch). Còn {untranslatedCount} dòng → cần ~<b>{quotaHint.requestsNeeded} request</b>.
                      </p>
                      <p>
                        Xoay 3 model ≈ ~{quotaHint.maxLinesDay} dòng/ngày tối đa. <b>{quotaHint.keysCount} key cùng 1 tài khoản Google không nhân quota.</b>
                        {quotaHint.daysNeeded > 1 && (
                          <> Ước tính cần <b>{quotaHint.daysNeeded} ngày</b> (bấm Tiếp tục dịch mỗi ngày).</>
                        )}
                      </p>
                    </div>
                  )}
                </div>

                <button
                  onClick={handleTranslateSrt}
                  disabled={(subtitles.length === 0 && !largeSrtMode) || isTranslateRunning}
                  className="w-full h-12 rounded-xl bg-cyan-500 text-black font-black text-xs flex items-center justify-center gap-2 hover:bg-white transition-all disabled:opacity-50"
                >
                  {isTranslateRunning ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      <span>ĐANG DỊCH PHỤ ĐỀ ({translateProgress}%)</span>
                    </>
                  ) : hasPartialTranslation ? (
                    <>
                      <Cpu className="w-4 h-4" />
                      <span>DỊCH SÓT ({missedLineCount.toLocaleString()} dòng)</span>
                    </>
                  ) : (
                    <>
                      <Cpu className="w-4 h-4" />
                      <span>BẮT ĐẦU DỊCH THUẬT BẰNG AI</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleDownloadTranslatedSrt}
                  disabled={translatedLineCount === 0 || isTranslateRunning}
                  className="w-full h-10 rounded-xl bg-white/5 border border-emerald-500/30 text-emerald-400 font-bold text-xs flex items-center justify-center gap-2 hover:bg-emerald-500/20 transition-all disabled:opacity-40"
                >
                  <Download className="w-4 h-4" />
                  TẢI SRT ({translatedLineCount.toLocaleString()} dòng dịch / {effectiveSubtitleCount.toLocaleString() || 0} tổng)
                </button>

                <button
                  type="button"
                  onClick={handleImportResumeViSrt}
                  disabled={isTranslateRunning || (!sourceSrtPath && subtitles.length === 0)}
                  className="w-full h-10 rounded-xl bg-white/5 border border-amber-500/30 text-amber-300 font-bold text-xs flex items-center justify-center gap-2 hover:bg-amber-500/15 transition-all disabled:opacity-40"
                  title="Import file SRT đã tải về để tiếp tục dịch sót"
                >
                  <Upload className="w-4 h-4" />
                  IMPORT BẢN DỊCH (tiếp tục dịch sót)
                </button>

                {missedLineCount > 0 && hasAnyTranslation && (
                  <p className="text-[10px] text-amber-400/90 px-1">
                    Còn {missedLineCount.toLocaleString()} dòng sót (trống, giống gốc, hoặc còn tiếng Trung). Bấm <b>Dịch sót</b> hoặc import lại file đã tải.
                  </p>
                )}

                {/* Translate progress & log — luôn hiển thị để xem lỗi */}
                <div className="flex flex-col gap-2 p-4 rounded-xl bg-black/40 border border-cyan-500/20 font-mono text-[9px] text-gray-400">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-gray-300">Nhật ký dịch</span>
                    <span className="text-cyan-400 font-bold">{translateProgress}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${isTranslateRunning ? 'bg-cyan-500 animate-pulse' : 'bg-cyan-500/70'}`}
                      style={{ width: `${Math.max(translateProgress, isTranslateRunning ? 2 : 0)}%` }}
                    />
                  </div>
                  <div className="h-28 overflow-y-auto border-t border-white/5 pt-2 flex flex-col gap-1 text-[9px] text-cyan-300 custom-scrollbar">
                    {translateLogs.length > 0 ? (
                      translateLogs.map((line, i) => (
                        <span key={`${i}-${line.slice(0, 24)}`}>{line}</span>
                      ))
                    ) : (
                      <span className="text-gray-500">
                        {translateStatus || 'Chưa có log — bấm "Bắt đầu dịch" để xem tiến trình tại đây.'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Side-by-Side Editor */}
              <div className="lg:col-span-2 glass-panel p-6 flex flex-col gap-4">
                <div className="flex justify-between items-center gap-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Trình biên tập song ngữ Gốc & Dịch</h3>
                  <button
                    type="button"
                    onClick={handleDownloadTranslatedSrt}
                    disabled={translatedLineCount === 0 || isTranslateRunning}
                    className="h-8 px-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-bold text-[10px] flex items-center gap-1.5 hover:bg-emerald-500/25 transition-all disabled:opacity-40"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Tải .srt
                  </button>
                </div>

                <div className="h-[480px] border border-white/5 bg-black/20 rounded-xl overflow-y-auto p-4 flex flex-col gap-2.5 custom-scrollbar">
                  {largeSrtMode ? (
                    <div className="text-center py-12 text-gray-500 text-xs">
                      File quá lớn để hiển thị từng dòng ({subtitleLineCount.toLocaleString()} dòng).
                      <br />
                      Tiến độ dịch hiển thị bên trái — tải file SRT sau khi hoàn tất.
                    </div>
                  ) : subtitles.length > 0 ? (
                    subtitles.map((sub, i) => {
                      const missed = isMissedLine(sub.text, translatedSubtitles[i]?.text);
                      return (
                      <div
                        key={sub.id}
                        className={`p-3 rounded-xl border bg-white/5 grid grid-cols-2 gap-4 transition-all ${
                          missed
                            ? 'border-amber-500/40 hover:border-amber-400/60'
                            : 'border-white/5 hover:border-cyan-500/30'
                        }`}
                      >
                        <div className="flex flex-col gap-1 border-r border-white/5 pr-3">
                          <span className="text-[9px] font-mono text-cyan-400">GỐC #{sub.id} ({sub.start})</span>
                          <span className="text-xs text-gray-300">{sub.text}</span>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] font-mono text-purple-400">
                            DỊCH TIẾNG VIỆT{missed ? ' · SÓT' : ''}
                          </span>
                          <input
                            type="text"
                            value={translatedSubtitles[i]?.text || ''}
                            onChange={(e) => {
                              const newTrans = [...translatedSubtitles];
                              newTrans[i].text = e.target.value;
                              setTranslatedSubtitles(newTrans);
                            }}
                            placeholder={missed ? 'Chưa dịch / dịch sót...' : 'Đang đợi dịch...'}
                            className="bg-transparent border-none text-xs text-white focus:outline-none focus:ring-0 w-full placeholder-gray-600 font-bold"
                          />
                        </div>
                      </div>
                    );})
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-gray-600">
                      Vui lòng trích xuất OCR ở tab 1 trước!
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 3: VOICE CONFIGURATION (CapCut reference) --- */}
        {activeTab === 'voice' && (
          <div className="flex flex-col gap-6 animate-fadeIn">
            <div className="flex justify-between items-start gap-4">
              <div>
                <h2 className="text-2xl font-black tracking-tight">Thiết Lập Lồng Tiếng</h2>
                <p className="text-xs text-gray-500">
                  Cấu hình giọng đọc — import SRT tiếng Việt có sẵn để bỏ qua bước dịch
                </p>
              </div>
              <button
                onClick={handleImportViSrt}
                className="h-10 px-5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500 hover:text-black font-bold text-xs flex items-center gap-2 transition-all text-emerald-300 shrink-0"
              >
                <FileText className="w-4 h-4" /> Import SRT Tiếng Việt
              </button>
            </div>

            {hasDubbingSubtitles ? (
              <div className="glass-panel p-4 border border-emerald-500/20 bg-emerald-500/5 text-xs text-emerald-200">
                {viSrtPath
                  ? `Phụ đề tiếng Việt: ${translatedLineCount} dòng từ ${viSrtPath.split(/[\\/]/).pop()}`
                  : `Phụ đề lồng tiếng: ${translatedLineCount} dòng sẵn sàng`}
              </div>
            ) : (
              <div className="glass-panel p-4 border border-amber-500/20 bg-amber-500/5 text-xs text-amber-200">
                Chưa có phụ đề tiếng Việt. Import file SRT VI hoặc dịch ở tab 2 trước khi kết xuất.
              </div>
            )}

            {/* Credential settings */}
            <div className="glass-panel p-6 grid grid-cols-3 gap-4">
              <Select
                label="Server 1 (Default)"
                options={VOICE_PROVIDERS.map(p => ({ value: p.id, label: p.label }))}
                value={voiceSettings[0].provider}
                onChange={(val) => updateVoiceSetting(0, 'provider', val)}
              />
              <Select
                label="Server 2"
                options={VOICE_PROVIDERS.map(p => ({ value: p.id, label: p.label }))}
                value={voiceSettings[1].provider}
                onChange={(val) => updateVoiceSetting(1, 'provider', val)}
              />
              <Select
                label="Server 3"
                options={VOICE_PROVIDERS.map(p => ({ value: p.id, label: p.label }))}
                value={voiceSettings[2].provider}
                onChange={(val) => updateVoiceSetting(2, 'provider', val)}
              />
            </div>

            {/* Custom 3 voice setups, exactly matching CapCut popup cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[0, 1, 2].map((idx) => {
                const setting = voiceSettings[idx];
                let colorClass = 'border-cyan-500';
                let dotClass = 'bg-cyan-400';
                if (idx === 1) { colorClass = 'border-purple-500'; dotClass = 'bg-purple-400'; }
                if (idx === 2) { colorClass = 'border-amber-500'; dotClass = 'bg-amber-400'; }

                return (
                  <div key={idx} className={`glass-panel p-5 flex flex-col gap-4 border-t-4 ${colorClass} relative overflow-hidden group`}>
                    <div className="flex justify-between items-center">
                      <h3 className="text-xs font-bold text-gray-200">
                        Giọng Đọc {idx + 1}
                        {idx === 0 && <span className="ml-2 text-[8px] bg-white/5 px-1.5 py-0.5 rounded text-gray-400">Mặc định</span>}
                      </h3>
                      <div className={`w-1.5 h-1.5 rounded-full ${dotClass} shadow-[0_0_8px_rgba(255,255,255,0.4)] animate-pulse`} />
                    </div>

                    <Select
                      label="Giọng đọc"
                      options={VOICE_DATA.vn.map(v => ({ value: v, label: v }))}
                      value={setting.voice}
                      onChange={(val) => updateVoiceSetting(idx, 'voice', val)}
                    />

                    <div className="text-[9px] text-green-400 font-bold px-1 flex justify-between items-center">
                      <span>Đơn giá: 500 credit/phút</span>
                      <button className="p-1.5 rounded-full bg-white/5 hover:bg-cyan-500 hover:text-black transition-all">
                        <Play className="w-2.5 h-2.5 fill-current" />
                      </button>
                    </div>

                    <div className="flex flex-col gap-4 mt-2">
                      <Slider
                        label="Tốc độ"
                        unit="x"
                        min={0.5}
                        max={2.0}
                        step={0.1}
                        value={setting.speed}
                        onChange={(val) => updateVoiceSetting(idx, 'speed', val)}
                      />
                      <Slider
                        label="Âm lượng"
                        unit="%"
                        min={0}
                        max={200}
                        value={setting.volume}
                        onChange={(val) => updateVoiceSetting(idx, 'volume', val)}
                      />
                      <Slider
                        label="Cao độ"
                        unit=""
                        min={-20}
                        max={20}
                        value={setting.pitch}
                        onChange={(val) => updateVoiceSetting(idx, 'pitch', val)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Optional paid API Key inputs if they choose paid servers */}
            <div className="glass-panel p-6 flex flex-col gap-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Khóa kết nối máy chủ trả phí (Nếu dùng)</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[9px] font-bold text-gray-400 px-1">Google Cloud API Key</label>
                  <input
                    type="password"
                    value={googleKey}
                    onChange={(e) => setGoogleKey(e.target.value)}
                    placeholder="Nhập Google TTS Key..."
                    className="h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[9px] font-bold text-gray-400 px-1">OpenAI API Key</label>
                  <input
                    type="password"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    placeholder="Nhập OpenAI Key..."
                    className="h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[9px] font-bold text-gray-400 px-1">ElevenLabs API Key</label>
                  <input
                    type="password"
                    value={elevenlabsKey}
                    onChange={(e) => setElevenlabsKey(e.target.value)}
                    placeholder="Nhập ElevenLabs Key..."
                    className="h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>
            </div>

            {/* Dubbing Mode Selection, matching the user reference design */}
            <div className="glass-panel p-6 flex flex-col gap-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Chế Độ Lồng Tiếng</h3>
              <div className="grid grid-cols-2 gap-4">
                {DUBBING_MODES.map((mode) => (
                  <div
                    key={mode.id}
                    onClick={() => setDubbingMode(mode.id)}
                    className={`p-5 rounded-2xl border cursor-pointer transition-all duration-300 relative group flex flex-col gap-2 ${
                      dubbingMode === mode.id
                        ? 'bg-cyan-500/10 border-cyan-500 shadow-[0_0_15px_rgba(6,182,212,0.2)]'
                        : 'bg-white/5 border-white/10 hover:border-white/20'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <span className={`text-sm font-black ${dubbingMode === mode.id ? 'text-cyan-400' : 'text-gray-300'}`}>
                        {mode.label}
                      </span>
                      {dubbingMode === mode.id && <Check className="w-4 h-4 text-cyan-400 stroke-[3]" />}
                    </div>
                    <p className="text-xs text-gray-400 leading-relaxed">{mode.description}</p>
                    <div className="text-[9px] font-bold text-cyan-500/80 mt-2 font-mono group-hover:text-cyan-400">
                      {mode.bestFor}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 4: MIX & RENDER --- */}
        {activeTab === 'mix' && (
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-start gap-4">
              <div>
                <h2 className="text-2xl font-black tracking-tight">Trộn Âm & Xuất Bản Video</h2>
                <p className="text-xs text-gray-500">
                  Cần video + phụ đề tiếng Việt (dịch AI hoặc import SRT có sẵn)
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={handleImportVideo}
                  disabled={!!videoPath}
                  className="h-10 px-4 rounded-xl bg-white/5 border border-white/10 hover:bg-cyan-500 hover:text-black font-bold text-xs flex items-center gap-2 transition-all disabled:opacity-40"
                >
                  <Upload className="w-4 h-4" /> Video
                </button>
                <button
                  onClick={handleImportViSrt}
                  className="h-10 px-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500 hover:text-black font-bold text-xs flex items-center gap-2 transition-all text-emerald-300"
                >
                  <FileText className="w-4 h-4" /> SRT VI
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Mix settings */}
              <div className="glass-panel p-6 flex flex-col gap-5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Thiết Lập Trộn Âm</h3>

                <Checkbox
                  label="Giữ lại âm thanh gốc của video"
                  checked={keepOriginalAudio}
                  onChange={setKeepOriginalAudio}
                />

                {keepOriginalAudio && (
                  <div className="flex flex-col gap-5 border-t border-white/5 pt-4">
                    <Slider
                      label="Âm lượng giọng đọc AI"
                      unit="%"
                      min={0}
                      max={200}
                      value={mixing.ai}
                      onChange={(val) => setMixing(prev => ({ ...prev, ai: val }))}
                    />
                    <Slider
                      label="Âm lượng nhạc nền gốc (Music)"
                      unit="%"
                      min={0}
                      max={100}
                      value={mixing.bg}
                      onChange={(val) => setMixing(prev => ({ ...prev, bg: val }))}
                    />
                    <Slider
                      label="Âm lượng giọng nói gốc (Voice)"
                      unit="%"
                      min={0}
                      max={100}
                      value={mixing.voice}
                      onChange={(val) => setMixing(prev => ({ ...prev, voice: val }))}
                    />
                  </div>
                )}

                <button
                  onClick={handleStartDubbing}
                  disabled={!videoPath || !hasDubbingSubtitles || isRenderRunning}
                  className="w-full h-14 rounded-2xl bg-cyan-500 text-black font-black text-sm flex items-center justify-center gap-3 shadow-[0_0_30px_rgba(6,182,212,0.4)] hover:bg-white transition-all disabled:opacity-30 disabled:grayscale cyan-glow mt-4"
                >
                  {isRenderRunning ? (
                    <>
                      <Loader className="w-5 h-5 animate-spin" />
                      <span>ĐANG KẾT XUẤT ({renderProgress}%)</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-5 h-5" />
                      <span>BẮT ĐẦU KẾT XUẤT VIDEO</span>
                    </>
                  )}
                </button>
                {!videoPath && (
                  <p className="text-[10px] text-amber-400/90 text-center">Chưa import video</p>
                )}
                {videoPath && !hasDubbingSubtitles && (
                  <p className="text-[10px] text-amber-400/90 text-center">Chưa có phụ đề tiếng Việt — import SRT VI hoặc dịch AI</p>
                )}
              </div>

              {/* Progress & final console logs */}
              <div className="lg:col-span-2 glass-panel p-6 flex flex-col gap-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Nhật ký kết xuất lồng tiếng</h3>

                <div className="h-[280px] border border-white/5 bg-black/60 rounded-xl p-4 font-mono text-[10px] text-cyan-300 overflow-y-auto flex flex-col gap-1.5 custom-scrollbar">
                  <span>[Hệ thống] {renderStatus}</span>
                  {isRenderRunning && <span>[Tiến trình] Đang tổng hợp các file audio lồng tiếng...</span>}
                  {renderProgress === 100 && <span>[Hoàn tất] Kết xuất thành công file video.</span>}
                </div>

                {/* Progress bar */}
                {(isRenderRunning || renderProgress > 0) && (
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-xs font-bold text-gray-400">
                      <span>Tiến độ kết xuất:</span>
                      <span className="text-cyan-400">{renderProgress}%</span>
                    </div>
                    <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-cyan-500 shadow-[0_0_10px_var(--neon-cyan)] transition-all duration-300"
                        style={{ width: `${renderProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Rendered completion message */}
                {renderedVideoPath && (
                  <div className="p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-cyan-400 font-bold text-xs">
                      <CheckCircle className="w-4 h-4" />
                      <span>Đã lồng tiếng và trộn âm thành công!</span>
                    </div>
                    <p className="text-[10px] text-gray-400 leading-relaxed font-mono">
                      <b>Đường dẫn video:</b> {renderedVideoPath}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* File Browser Modal (Web Mode Only) */}
      <FileBrowser
        isOpen={showFileBrowser}
        onClose={() => setShowFileBrowser(false)}
        onSelect={async (filePath) => {
          setShowFileBrowser(false);
          await loadVideo(filePath);
        }}
        title="Chọn Video"
        filterType="video"
      />

      <FileBrowser
        isOpen={showSrtBrowser}
        onClose={() => setShowSrtBrowser(false)}
        onSelect={async (filePath) => {
          setShowSrtBrowser(false);
          if (srtImportMode === 'vietnamese') {
            await loadViSrt(filePath);
          } else if (srtImportMode === 'resume') {
            await loadResumeViSrt(filePath);
          } else {
            await loadSrt(filePath);
          }
        }}
        title={
          srtImportMode === 'vietnamese'
            ? 'Chọn SRT Tiếng Việt'
            : srtImportMode === 'resume'
              ? 'Import SRT đã dịch (một phần) để tiếp tục'
              : 'Chọn SRT Gốc (cần dịch)'
        }
        filterType="subtitle"
      />
    </div>
  );
}
