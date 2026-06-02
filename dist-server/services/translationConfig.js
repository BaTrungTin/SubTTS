"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRANSLATION_PROMPT_PREFIX = exports.BATCH_SIZE_DEFAULT_CAP = exports.BATCH_SIZE_MAX = exports.BATCH_SIZE_MIN = exports.DEFAULT_OPENROUTER_MODEL = exports.OPENROUTER_MODELS = void 0;
exports.computeTranslationBatchSize = computeTranslationBatchSize;
/** Models phổ biến trên OpenRouter — có thể chọn khi dịch */
exports.OPENROUTER_MODELS = [
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
exports.DEFAULT_OPENROUTER_MODEL = exports.OPENROUTER_MODELS[0].id;
/** Số dòng tối thiểu / tối đa mỗi request dịch (0 = chỉ dùng auto). */
exports.BATCH_SIZE_MIN = 40;
exports.BATCH_SIZE_MAX = 200;
exports.BATCH_SIZE_DEFAULT_CAP = 200;
function computeTranslationBatchSize(lineCount, avgCharsPerLine = 35, userOverride) {
    if (userOverride != null && userOverride > 0) {
        return Math.max(exports.BATCH_SIZE_MIN, Math.min(userOverride, exports.BATCH_SIZE_MAX));
    }
    let size = avgCharsPerLine < 40 ? 120 : avgCharsPerLine < 80 ? 80 : 50;
    if (lineCount > 500)
        size = Math.min(size + 25, exports.BATCH_SIZE_DEFAULT_CAP);
    if (lineCount > 5000)
        size = Math.min(size + 25, exports.BATCH_SIZE_DEFAULT_CAP);
    return Math.max(exports.BATCH_SIZE_MIN, Math.min(size, exports.BATCH_SIZE_DEFAULT_CAP));
}
exports.TRANSLATION_PROMPT_PREFIX = `Dịch phụ đề Trung Quốc sang tiếng Việt tự nhiên (drama/hài/livestream). Ưu tiên ngữ cảnh, không dịch word-by-word, không Hán Việt cứng.
Tránh sai: 正经/不正经→"bình thường" (không "tử tế"); 主播→streamer; 楼上→bên trên; 手法→cách làm.
Mỗi dòng gốc = đúng 1 dòng tiếng Việt, giữ thứ tự, không số thứ tự, không giải thích. Chỉ trả bản dịch, mỗi dòng một \\n.

Dịch:
`;
