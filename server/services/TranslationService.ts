import { GeminiTranslator, TranslateSrtCallbacks, TranslateSrtResult } from './GeminiTranslator';
import { OpenRouterTranslator } from './OpenRouterTranslator';
import type { TranslationProvider } from './translationConfig';

export interface TranslationServiceOptions {
  provider?: TranslationProvider;
  model?: string;
  /** Số dòng mỗi batch; 0 hoặc bỏ qua = tự động theo độ dài dòng */
  batchSize?: number;
}

export class TranslationService {
  private gemini = new GeminiTranslator();
  private openRouter = new OpenRouterTranslator();

  async translateSrt(
    srtContent: string,
    apiKeys: string[],
    onProgress: (progress: number, log: string) => void,
    callbacks: TranslateSrtCallbacks = {},
    options: TranslationServiceOptions = {}
  ): Promise<TranslateSrtResult> {
    const provider = options.provider ?? 'gemini';

    if (provider === 'openrouter') {
      return this.openRouter.translateSrt(
        srtContent,
        apiKeys,
        options.model ?? '',
        onProgress,
        callbacks,
        options.batchSize
      );
    }

    return this.gemini.translateSrt(
      srtContent,
      apiKeys,
      onProgress,
      callbacks,
      options.batchSize
    );
  }
}
