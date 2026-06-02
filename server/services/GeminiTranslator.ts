import axios from 'axios';
import { computeTranslationBatchSize } from './translationConfig';
import { parseSrtContent, countValidTranslations, isValidTranslation } from '../srtUtils';

/** Mỗi model có hạn RPD riêng trên free tier (~20 req/ngày/model). Xoay model = gấp đôi quota ngày. */
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

/** Free tier ~10 RPM — giữ ~1 batch / 7s để tránh 429 RPM */
const BATCH_DELAY_MS = 7000;
const FREE_TIER_RPD_PER_MODEL = 20;

const TRANSLATION_PROMPT_PREFIX = `Dịch phụ đề Trung Quốc sang tiếng Việt tự nhiên (drama/hài/livestream). Ưu tiên ngữ cảnh, không dịch word-by-word, không Hán Việt cứng.
Tránh sai: 正经/不正经→"bình thường" (không "tử tế"); 主播→streamer; 楼上→bên trên; 手法→cách làm.
Mỗi dòng gốc = đúng 1 dòng tiếng Việt, giữ thứ tự, không số thứ tự, không giải thích. Chỉ trả bản dịch, mỗi dòng một \\n.

Dịch:
`;

interface GeminiErrorInfo {
  status?: number;
  message: string;
  googleStatus?: string;
  retryable: boolean;
  rotateKey: boolean;
  tryNextModel: boolean;
}

export interface SubtitleItem {
  id: string;
  start: string;
  end: string;
  text: string;
}

export interface TranslateSrtResult {
  content: string;
  translatedCount: number;
  totalCount: number;
  isComplete: boolean;
  missedCount: number;
  quotaExhausted: boolean;
}

export interface TranslateSrtCallbacks {
  existingTranslations?: Record<number, string>;
  onBatchComplete?: (updates: { index: number; text: string }[]) => void;
}

export class GeminiTranslator {
  /** Ước tính số request API cần cho số dòng còn lại (free tier ~20 RPD/model). */
  static estimateQuota(linesRemaining: number, batchSize?: number): {
    batchSize: number;
    requestsNeeded: number;
    modelsAvailable: number;
    maxLinesPerDayApprox: number;
  } {
    const size =
      batchSize ?? GeminiTranslator.computeBatchSizeFromLineCount(linesRemaining);
    const requestsNeeded = Math.max(1, Math.ceil(linesRemaining / size));
    const modelsAvailable = GEMINI_MODELS.length;
    const maxLinesPerDayApprox = FREE_TIER_RPD_PER_MODEL * modelsAvailable * size;
    return { batchSize: size, requestsNeeded, modelsAvailable, maxLinesPerDayApprox };
  }

  private static computeBatchSizeFromLineCount(
    lineCount: number,
    avgCharsPerLine = 35,
    userOverride?: number
  ): number {
    return computeTranslationBatchSize(lineCount, avgCharsPerLine, userOverride);
  }

  private computeBatchSize(subtitles: SubtitleItem[], userOverride?: number): number {
    if (subtitles.length === 0) return 80;
    const avgChars =
      subtitles.reduce((sum, s) => sum + s.text.length, 0) / subtitles.length;
    return GeminiTranslator.computeBatchSizeFromLineCount(
      subtitles.length,
      avgChars,
      userOverride
    );
  }

  private isDailyQuotaExhausted(info: GeminiErrorInfo, message: string): boolean {
    const m = message.toLowerCase();
    return (
      info.googleStatus === 'RESOURCE_EXHAUSTED' ||
      m.includes('per day') ||
      m.includes('daily') ||
      m.includes('rpd') ||
      (info.status === 429 && m.includes('quota'))
    );
  }

  private parseGeminiError(error: unknown): GeminiErrorInfo {
    const err = error as {
      response?: { status?: number; data?: { error?: { message?: string; status?: string } } };
      message?: string;
      code?: string;
    };
    const status = err.response?.status;
    const googleStatus = err.response?.data?.error?.status || '';
    const message =
      err.response?.data?.error?.message || err.message || 'Lỗi không xác định';

    if (status === 429 || status === 503 || googleStatus === 'RESOURCE_EXHAUSTED') {
      return {
        status,
        message,
        googleStatus,
        retryable: true,
        rotateKey: true,
        tryNextModel: false,
      };
    }

    if (
      status === 401 ||
      googleStatus === 'UNAUTHENTICATED' ||
      /api key not valid/i.test(message)
    ) {
      return {
        status,
        message,
        googleStatus,
        retryable: false,
        rotateKey: true,
        tryNextModel: false,
      };
    }

    if (status === 403) {
      return {
        status,
        message,
        googleStatus,
        retryable: false,
        rotateKey: true,
        tryNextModel: false,
      };
    }

    if (status === 404 || googleStatus === 'NOT_FOUND' || /not found/i.test(message)) {
      return {
        status,
        message,
        googleStatus,
        retryable: true,
        rotateKey: false,
        tryNextModel: true,
      };
    }

    if (err.code === 'ECONNABORTED' || /timeout/i.test(message)) {
      return {
        status,
        message: 'Hết thời gian chờ phản hồi (60s)',
        googleStatus: 'TIMEOUT',
        retryable: true,
        rotateKey: false,
        tryNextModel: false,
      };
    }

    if (status === 400 && googleStatus === 'INVALID_ARGUMENT') {
      return {
        status,
        message,
        googleStatus,
        retryable: false,
        rotateKey: false,
        tryNextModel: false,
      };
    }

    return {
      status,
      message,
      googleStatus,
      retryable: true,
      rotateKey: true,
      tryNextModel: false,
    };
  }

  private extractTextFromResponse(data: unknown): string {
    const body = data as {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string }> };
      }>;
      promptFeedback?: { blockReason?: string };
    };

    const blockReason = body.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini chặn prompt: ${blockReason}`);
    }

    const candidate = body.candidates?.[0];
    if (!candidate) {
      throw new Error('Gemini không trả về nội dung (kiểm tra API key và model)');
    }

    const finish = candidate.finishReason;
    if (finish === 'SAFETY' || finish === 'RECITATION') {
      throw new Error(`Gemini từ chối dịch (${finish}) — thử giảm batch hoặc chỉnh nội dung`);
    }

    const text = (candidate.content?.parts || [])
      .map((p) => p.text || '')
      .join('\n')
      .trim();

    if (!text) {
      throw new Error(
        `Phản hồi rỗng từ Gemini (finishReason: ${finish || 'UNKNOWN'})`
      );
    }

    return text;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async translateSrt(
    srtContent: string,
    apiKeys: string[],
    onProgress: (progress: number, log: string) => void,
    callbacks: TranslateSrtCallbacks = {},
    batchSizeOverride?: number
  ): Promise<TranslateSrtResult> {
    const normalizedKeys = apiKeys
      .map((k) => k.trim().replace(/\s+/g, ''))
      .filter((k) => k.length > 10);

    if (normalizedKeys.length === 0) {
      throw new Error("No Gemini API keys provided!");
    }

    const { existingTranslations = {}, onBatchComplete } = callbacks;

    onProgress(0.05, "Parsing SRT subtitle file...");
    const subtitles = this.parseSrt(srtContent);
    if (subtitles.length === 0) {
      throw new Error("No subtitles found in the SRT content!");
    }

    const translatedSubtitles: SubtitleItem[] = subtitles.map((sub, index) => {
      const existing = existingTranslations[index]?.trim();
      if (existing && isValidTranslation(sub.text, existing)) {
        return { ...sub, text: existing };
      }
      return { ...sub, text: '' };
    });

    const hasValidTranslationAt = (index: number): boolean =>
      isValidTranslation(
        subtitles[index].text,
        existingTranslations[index] || translatedSubtitles[index]?.text
      );

    let alreadyDone = subtitles.filter((_, i) => hasValidTranslationAt(i)).length;

    const pendingBatches: { index: number; batch: SubtitleItem[]; retries?: number }[] = [];
    const batchSize = this.computeBatchSize(subtitles, batchSizeOverride);
    const linesRemaining = subtitles.length - alreadyDone;
    const quotaEst = GeminiTranslator.estimateQuota(linesRemaining, batchSize);

    onProgress(
      0.08,
      `Gói free: ~${FREE_TIER_RPD_PER_MODEL} request/ngày/model × ${quotaEst.modelsAvailable} model ≈ ${quotaEst.maxLinesPerDayApprox} dòng/ngày. ` +
        `Batch ${batchSize} dòng → cần ~${quotaEst.requestsNeeded} request cho ${linesRemaining} dòng còn lại. ` +
        `(3 key cùng 1 tài khoản Google KHÔNG nhân đôi quota ngày.)`
    );

    for (let i = 0; i < subtitles.length; i += batchSize) {
      const batch = subtitles.slice(i, i + batchSize);
      const allDone = batch.every((_, subIdx) => hasValidTranslationAt(i + subIdx));
      if (!allDone) {
        pendingBatches.push({ index: i, batch });
      }
    }

    if (pendingBatches.length === 0) {
      onProgress(1, "All lines already translated. Nothing left to do.");
      return {
        ...this.buildTranslateResult(subtitles, translatedSubtitles, false),
        translatedCount: subtitles.length,
        totalCount: subtitles.length,
        isComplete: true,
        missedCount: 0,
        quotaExhausted: false,
      };
    }

    onProgress(
      0.1,
      alreadyDone > 0
        ? `Tiếp tục: đã có ${alreadyDone}/${subtitles.length} dòng hợp lệ. Còn ${subtitles.length - alreadyDone} dòng...`
        : `Bắt đầu dịch ${subtitles.length} dòng (batch ${batchSize})...`
    );

    const concurrency = 1;
    const totalPending = pendingBatches.length;
    let completedBatches = 0;
    const exhaustedModels = new Set<string>();
    let stoppedForQuota = false;

    const worker = async (workerId: number) => {
      let currentKeyIndex = workerId % normalizedKeys.length;
      let batchModelIndex = 0;

      while (pendingBatches.length > 0 && !stoppedForQuota) {
        const item = pendingBatches.shift();
        if (!item) break;

        const { index, batch } = item;
        const batchLines: string[] = [];
        const batchIndices: number[] = [];

        batch.forEach((sub, subIdx) => {
          const globalIdx = index + subIdx;
          if (!hasValidTranslationAt(globalIdx)) {
            batchLines.push(sub.text);
            batchIndices.push(globalIdx);
          }
        });

        if (batchLines.length === 0) {
          completedBatches++;
          continue;
        }

        const progressPercent =
          0.1 + 0.8 * ((alreadyDone + (completedBatches / totalPending) * (subtitles.length - alreadyDone)) / subtitles.length);

        onProgress(
          progressPercent,
          `Translating lines ${batchIndices[0] + 1} to ${batchIndices[batchIndices.length - 1] + 1} / ${subtitles.length}...`
        );

        try {
          while (
            exhaustedModels.has(GEMINI_MODELS[batchModelIndex % GEMINI_MODELS.length]) &&
            exhaustedModels.size < GEMINI_MODELS.length
          ) {
            batchModelIndex++;
          }

          const result = await this.translateBatchWithRotation(
            batchLines,
            normalizedKeys,
            currentKeyIndex,
            batchModelIndex % GEMINI_MODELS.length,
            exhaustedModels,
            (logMsg) => onProgress(progressPercent, logMsg)
          );

          currentKeyIndex = result.lastKeyIndex;
          batchModelIndex = (result.lastModelIndex + 1) % GEMINI_MODELS.length;

          const updates: { index: number; text: string }[] = [];
          batchIndices.forEach((globalIdx, lineIdx) => {
            const candidate = (result.lines[lineIdx] || '').trim();
            const valid = isValidTranslation(subtitles[globalIdx].text, candidate);
            const translatedText = valid ? candidate : '';
            translatedSubtitles[globalIdx] = {
              ...subtitles[globalIdx],
              text: translatedText,
            };
            if (valid) {
              updates.push({ index: globalIdx, text: translatedText });
              alreadyDone++;
            }
          });

          if (onBatchComplete && updates.length > 0) {
            onBatchComplete(updates);
          }

          await this.sleep(BATCH_DELAY_MS);
        } catch (batchError: unknown) {
          const msg = batchError instanceof Error ? batchError.message : String(batchError);
          const quotaHit =
            exhaustedModels.size >= GEMINI_MODELS.length ||
            /quota|429|RESOURCE_EXHAUSTED|hết quota|per day|rpd/i.test(msg);

          if (quotaHit) {
            stoppedForQuota = true;
            pendingBatches.unshift(item);
            onProgress(
              progressPercent,
              `⏸ Hết quota Gemini hôm nay (~${FREE_TIER_RPD_PER_MODEL} request/ngày/model). ` +
                `Đã dịch ${alreadyDone}/${subtitles.length} dòng — bấm "Dịch sót" vào ngày mai hoặc dùng OpenRouter.`
            );
            break;
          }

          const retries = (item.retries || 0) + 1;
          item.retries = retries;
          if (retries < 4) {
            pendingBatches.push(item);
            onProgress(
              progressPercent,
              `[LỖI] Batch dòng ${batchIndices[0] + 1} (thử lại ${retries}/3): ${msg}`
            );
            await this.sleep(4000);
          } else {
            onProgress(
              progressPercent,
              `[BỎ QUA] Batch dòng ${batchIndices[0] + 1} sau 3 lần lỗi: ${msg}`
            );
          }
        }

        completedBatches++;
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, totalPending) },
      (_, idx) => worker(idx)
    );
    await Promise.all(workers);

    const result = this.buildTranslateResult(subtitles, translatedSubtitles, stoppedForQuota);
    onProgress(
      result.isComplete ? 0.95 : 0.9,
      result.isComplete
        ? 'Hoàn tất dịch — đang xuất file SRT...'
        : result.quotaExhausted
          ? `Tạm dừng (hết quota): ${result.translatedCount}/${result.totalCount} dòng. Còn ${result.missedCount} dòng — dịch sót vào ngày mai hoặc OpenRouter.`
          : `Tạm dừng: ${result.translatedCount}/${result.totalCount} dòng. Còn ${result.missedCount} dòng — bấm "Dịch sót".`
    );
    return result;
  }

  private buildTranslateResult(
    subtitles: SubtitleItem[],
    translatedSubtitles: SubtitleItem[],
    quotaExhausted: boolean
  ): TranslateSrtResult {
    const translatedCount = countValidTranslations(subtitles, translatedSubtitles);
    const missedCount = subtitles.length - translatedCount;
    const isComplete = missedCount === 0;
    const content = this.buildSrt(
      translatedSubtitles.map((sub, i) => {
        const orig = subtitles[i];
        if (isValidTranslation(orig.text, sub.text)) {
          return { ...orig, text: sub.text.trim() };
        }
        return { ...orig, text: '' };
      })
    );

    return {
      content,
      translatedCount,
      totalCount: subtitles.length,
      isComplete,
      missedCount,
      quotaExhausted,
    };
  }

  private async translateBatchWithRotation(
    texts: string[],
    apiKeys: string[],
    startKeyIndex: number,
    startModelIndex: number,
    exhaustedModels: Set<string>,
    logRotation: (msg: string) => void
  ): Promise<{ lines: string[]; lastKeyIndex: number; lastModelIndex: number }> {
    const prompt = `${TRANSLATION_PROMPT_PREFIX}${texts.join('\n')}`;

    let attempts = 0;
    const maxAttempts = Math.max(apiKeys.length * GEMINI_MODELS.length * 3, 12);
    let keyIndex = startKeyIndex % apiKeys.length;
    let modelIndex = startModelIndex % GEMINI_MODELS.length;
    let rateLimitRetriesOnSameKey = 0;
    const errorLog: string[] = [];

    while (attempts < maxAttempts) {
      const apiKey = apiKeys[keyIndex]?.trim();
      const model = GEMINI_MODELS[modelIndex];

      if (exhaustedModels.has(model)) {
        modelIndex = (modelIndex + 1) % GEMINI_MODELS.length;
        if (exhaustedModels.size >= GEMINI_MODELS.length) {
          throw new Error(
            `Đã hết quota ngày (RPD) cho tất cả model. Free tier ~${FREE_TIER_RPD_PER_MODEL} request/ngày/model. ` +
              `Chờ reset 0h PT hoặc nâng cấp billing. Tiếp tục dịch vào ngày mai.`
          );
        }
        attempts++;
        continue;
      }

      if (!apiKey) {
        keyIndex = (keyIndex + 1) % apiKeys.length;
        attempts++;
        continue;
      }

      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.5,
            },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 90000,
          }
        );

        const reply = this.extractTextFromResponse(response.data);

        const lines = reply
          .split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => l !== '');

        if (lines.length !== texts.length) {
          console.warn(
            `Translation lines count mismatch! Expected ${texts.length}, got ${lines.length}.`
          );
          if (lines.length > texts.length) {
            return { lines: lines.slice(0, texts.length), lastKeyIndex: keyIndex, lastModelIndex: modelIndex };
          }
          const padded = [...lines];
          while (padded.length < texts.length) {
            padded.push('');
          }
          return { lines: padded, lastKeyIndex: keyIndex, lastModelIndex: modelIndex };
        }

        return { lines, lastKeyIndex: keyIndex, lastModelIndex: modelIndex };
      } catch (error: unknown) {
        attempts++;
        const info = this.parseGeminiError(error);
        const detail = `Key #${keyIndex + 1} (${model}): [HTTP ${info.status ?? '?'}${info.googleStatus ? ` ${info.googleStatus}` : ''}] ${info.message}`;
        errorLog.push(detail);
        logRotation(`[LỖI] ${detail}`);

        if (this.isDailyQuotaExhausted(info, info.message)) {
          exhaustedModels.add(model);
          logRotation(
            `[INFO] Model ${model} hết quota ngày (~${FREE_TIER_RPD_PER_MODEL} RPD). Chuyển model khác...`
          );
          modelIndex = (modelIndex + 1) % GEMINI_MODELS.length;
          continue;
        }

        if (info.tryNextModel && modelIndex < GEMINI_MODELS.length - 1) {
          modelIndex++;
          logRotation(`[INFO] Thử model dự phòng: ${GEMINI_MODELS[modelIndex]}...`);
          continue;
        }

        if (info.status === 429 && rateLimitRetriesOnSameKey < 2) {
          rateLimitRetriesOnSameKey++;
          const waitSec = rateLimitRetriesOnSameKey * 5;
          logRotation(
            `[INFO] Rate limit — chờ ${waitSec}s, thử lại key #${keyIndex + 1} (lần ${rateLimitRetriesOnSameKey}/3)...`
          );
          await this.sleep(waitSec * 1000);
          continue;
        }

        rateLimitRetriesOnSameKey = 0;

        if (!info.retryable && !info.rotateKey) {
          throw new Error(info.message);
        }

        if (info.rotateKey) {
          const prevKey = keyIndex;
          keyIndex = (keyIndex + 1) % apiKeys.length;
          if (info.retryable) {
            logRotation(`[INFO] Đổi sang key #${keyIndex + 1}...`);
            await this.sleep(2000);
          } else if (prevKey === keyIndex) {
            break;
          }
          continue;
        }

        await this.sleep(1500);
      }
    }

    const recent = errorLog.slice(-4).join(' | ');
    const has429 = errorLog.some(
      (e) => e.includes('429') || e.includes('RESOURCE_EXHAUSTED')
    );
    if (has429 || exhaustedModels.size > 0) {
      throw new Error(
        `Hết quota/rate limit. Free tier: ~${FREE_TIER_RPD_PER_MODEL} request/ngày/model (không phải 10 req tổng). ` +
          `Chờ reset hoặc bấm Tiếp tục dịch ngày mai. Chi tiết: ${recent}`
      );
    }
    throw new Error(
      `Không gọi được Gemini API. Kiểm tra key tại https://aistudio.google.com/apikey và bật Generative Language API. Chi tiết: ${recent}`
    );
  }

  private parseSrt(srtContent: string): SubtitleItem[] {
    return parseSrtContent(srtContent);
  }

  private buildSrt(subtitles: SubtitleItem[]): string {
    return subtitles
      .map(
        (sub, index) =>
          `${index + 1}\n${sub.start} --> ${sub.end}\n${sub.text}\n`
      )
      .join('\n');
  }
}
