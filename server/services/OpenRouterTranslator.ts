import axios from 'axios';
import {
  computeTranslationBatchSize,
  TRANSLATION_PROMPT_PREFIX,
} from './translationConfig';
import { parseSrtContent, countValidTranslations, isValidTranslation } from '../srtUtils';
import type {
  SubtitleItem,
  TranslateSrtCallbacks,
  TranslateSrtResult,
} from './GeminiTranslator';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const BATCH_DELAY_MS = 3000;

interface OpenRouterErrorInfo {
  status?: number;
  message: string;
  retryable: boolean;
  rotateKey: boolean;
}

export class OpenRouterTranslator {
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    return OpenRouterTranslator.computeBatchSizeFromLineCount(
      subtitles.length,
      avgChars,
      userOverride
    );
  }

  private parseOpenRouterError(error: unknown): OpenRouterErrorInfo {
    const err = error as {
      response?: { status?: number; data?: { error?: { message?: string; code?: string } } };
      message?: string;
      code?: string;
    };
    const status = err.response?.status;
    const message =
      err.response?.data?.error?.message || err.message || 'Lỗi không xác định';

    if (status === 429 || status === 503) {
      return { status, message, retryable: true, rotateKey: true };
    }

    if (status === 402) {
      return {
        status,
        message: 'Hết credit OpenRouter — nạp thêm tại openrouter.ai/credits',
        retryable: false,
        rotateKey: false,
      };
    }

    if (status === 401 || status === 403 || /invalid.*key/i.test(message)) {
      return { status, message, retryable: false, rotateKey: true };
    }

    if (status === 404 || /model.*not found/i.test(message)) {
      return {
        status,
        message: `Model không tồn tại hoặc không khả dụng: ${message}`,
        retryable: false,
        rotateKey: false,
      };
    }

    if (err.code === 'ECONNABORTED' || /timeout/i.test(message)) {
      return {
        status,
        message: 'Hết thời gian chờ phản hồi (90s)',
        retryable: true,
        rotateKey: false,
      };
    }

    if (status === 400) {
      return { status, message, retryable: false, rotateKey: false };
    }

    return { status, message, retryable: true, rotateKey: true };
  }

  private extractTextFromResponse(data: unknown): string {
    const body = data as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      error?: { message?: string };
    };

    if (body.error?.message) {
      throw new Error(body.error.message);
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('OpenRouter không trả về nội dung (kiểm tra API key và model)');
    }

    return content;
  }

  async translateSrt(
    srtContent: string,
    apiKeys: string[],
    model: string,
    onProgress: (progress: number, log: string) => void,
    callbacks: TranslateSrtCallbacks = {},
    batchSizeOverride?: number
  ): Promise<TranslateSrtResult> {
    const normalizedKeys = apiKeys
      .map((k) => k.trim())
      .filter((k) => k.length > 10);

    if (normalizedKeys.length === 0) {
      throw new Error('Chưa nhập OpenRouter API key!');
    }

    if (!model?.trim()) {
      throw new Error('Chưa chọn model OpenRouter!');
    }

    const { existingTranslations = {}, onBatchComplete } = callbacks;

    onProgress(0.05, 'Parsing SRT subtitle file...');
    const subtitles = this.parseSrt(srtContent);
    if (subtitles.length === 0) {
      throw new Error('No subtitles found in the SRT content!');
    }

    const translatedSubtitles: SubtitleItem[] = subtitles.map((sub, index) => {
      const existing = existingTranslations[index]?.trim();
      if (existing) {
        return { ...sub, text: existing };
      }
      return { ...sub, text: '' };
    });

    let alreadyDone = Object.keys(existingTranslations).filter(
      (k) => existingTranslations[Number(k)]?.trim()
    ).length;

    const pendingBatches: { index: number; batch: SubtitleItem[] }[] = [];
    const batchSize = this.computeBatchSize(subtitles, batchSizeOverride);
    const linesRemaining = subtitles.length - alreadyDone;

    onProgress(
      0.08,
      `OpenRouter · model ${model} · batch ${batchSize} dòng → cần ~${Math.ceil(linesRemaining / batchSize)} request cho ${linesRemaining} dòng còn lại.`
    );

    for (let i = 0; i < subtitles.length; i += batchSize) {
      const batch = subtitles.slice(i, i + batchSize);
      const allDone = batch.every((_, subIdx) => {
        const globalIdx = i + subIdx;
        return Boolean(existingTranslations[globalIdx]?.trim());
      });
      if (!allDone) {
        pendingBatches.push({ index: i, batch });
      }
    }

    if (pendingBatches.length === 0) {
      onProgress(1, 'All lines already translated. Nothing left to do.');
      return {
        content: this.buildSrt(translatedSubtitles),
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
        ? `Resuming: ${alreadyDone}/${subtitles.length} lines already done. Translating ${subtitles.length - alreadyDone} remaining...`
        : `Found ${subtitles.length} lines. Starting OpenRouter translation...`
    );

    const totalPending = pendingBatches.length;
    let completedBatches = 0;
    let currentKeyIndex = 0;

    for (const item of pendingBatches) {
      const { index, batch } = item;
      const batchLines: string[] = [];
      const batchIndices: number[] = [];

      batch.forEach((sub, subIdx) => {
        const globalIdx = index + subIdx;
        const existing = existingTranslations[globalIdx]?.trim();
        if (!existing) {
          batchLines.push(sub.text);
          batchIndices.push(globalIdx);
        }
      });

      if (batchLines.length === 0) {
        completedBatches++;
        continue;
      }

      const progressPercent =
        0.1 +
        0.8 *
          ((alreadyDone + (completedBatches / totalPending) * (subtitles.length - alreadyDone)) /
            subtitles.length);

      onProgress(
        progressPercent,
        `Translating lines ${batchIndices[0] + 1} to ${batchIndices[batchIndices.length - 1] + 1} / ${subtitles.length}...`
      );

      try {
        const result = await this.translateBatchWithRotation(
          batchLines,
          normalizedKeys,
          model,
          currentKeyIndex,
          (logMsg) => onProgress(progressPercent, logMsg)
        );

        currentKeyIndex = result.lastKeyIndex;

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
        onProgress(progressPercent, `[LỖI] Batch dòng ${batchIndices[0] + 1}: ${msg}`);
      }

      completedBatches++;
    }

    const translatedCount = countValidTranslations(subtitles, translatedSubtitles);
    const isComplete = translatedCount >= subtitles.length;
    const content = this.buildSrt(
      translatedSubtitles.map((sub, i) => {
        const orig = subtitles[i];
        if (isValidTranslation(orig.text, sub.text)) {
          return { ...orig, text: sub.text.trim() };
        }
        return { ...orig, text: '' };
      })
    );

    onProgress(
      isComplete ? 0.95 : 0.9,
      isComplete
        ? 'Translation finished. Formatting SRT content...'
        : `Paused: ${translatedCount}/${subtitles.length} lines translated. Check API key/credits and continue.`
    );

    return {
      content,
      translatedCount,
      totalCount: subtitles.length,
      isComplete,
      missedCount: subtitles.length - translatedCount,
      quotaExhausted: false,
    };
  }

  private async translateBatchWithRotation(
    texts: string[],
    apiKeys: string[],
    model: string,
    startKeyIndex: number,
    logRotation: (msg: string) => void
  ): Promise<{ lines: string[]; lastKeyIndex: number }> {
    const prompt = `${TRANSLATION_PROMPT_PREFIX}${texts.join('\n')}`;

    let attempts = 0;
    const maxAttempts = Math.max(apiKeys.length * 3, 9);
    let keyIndex = startKeyIndex % apiKeys.length;
    let rateLimitRetriesOnSameKey = 0;
    const errorLog: string[] = [];

    while (attempts < maxAttempts) {
      const apiKey = apiKeys[keyIndex]?.trim();

      if (!apiKey) {
        keyIndex = (keyIndex + 1) % apiKeys.length;
        attempts++;
        continue;
      }

      try {
        const response = await axios.post(
          OPENROUTER_API_URL,
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.5,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://vibecode-dich-tieng-trung.local',
              'X-Title': 'VibeCode Dich Tieng Trung',
            },
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
            return { lines: lines.slice(0, texts.length), lastKeyIndex: keyIndex };
          }
          const padded = [...lines];
          while (padded.length < texts.length) {
            padded.push('');
          }
          return { lines: padded, lastKeyIndex: keyIndex };
        }

        return { lines, lastKeyIndex: keyIndex };
      } catch (error: unknown) {
        attempts++;
        const info = this.parseOpenRouterError(error);
        const detail = `Key #${keyIndex + 1} (${model}): [HTTP ${info.status ?? '?'}] ${info.message}`;
        errorLog.push(detail);
        logRotation(`[LỖI] ${detail}`);

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
    throw new Error(
      `Không gọi được OpenRouter API. Kiểm tra key tại https://openrouter.ai/keys và model đã chọn. Chi tiết: ${recent}`
    );
  }

  private parseSrt(srtContent: string): SubtitleItem[] {
    return parseSrtContent(srtContent);
  }

  private buildSrt(subtitles: SubtitleItem[]): string {
    return subtitles
      .map((sub, index) => `${index + 1}\n${sub.start} --> ${sub.end}\n${sub.text}\n`)
      .join('\n');
  }
}
