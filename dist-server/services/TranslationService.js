"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslationService = void 0;
const GeminiTranslator_1 = require("./GeminiTranslator");
const OpenRouterTranslator_1 = require("./OpenRouterTranslator");
class TranslationService {
    constructor() {
        this.gemini = new GeminiTranslator_1.GeminiTranslator();
        this.openRouter = new OpenRouterTranslator_1.OpenRouterTranslator();
    }
    async translateSrt(srtContent, apiKeys, onProgress, callbacks = {}, options = {}) {
        const provider = options.provider ?? 'gemini';
        if (provider === 'openrouter') {
            return this.openRouter.translateSrt(srtContent, apiKeys, options.model ?? '', onProgress, callbacks, options.batchSize);
        }
        return this.gemini.translateSrt(srtContent, apiKeys, onProgress, callbacks, options.batchSize);
    }
}
exports.TranslationService = TranslationService;
