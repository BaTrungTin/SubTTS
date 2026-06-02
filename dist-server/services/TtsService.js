"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TtsService = void 0;
const axios_1 = __importDefault(require("axios"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
class TtsService {
    constructor() {
        this.tempDir = path_1.default.join(os_1.default.tmpdir(), 'vibe-tts-clips');
        if (!fs_1.default.existsSync(this.tempDir)) {
            fs_1.default.mkdirSync(this.tempDir, { recursive: true });
        }
    }
    async generateSpeech(text, provider, voice, options, apiKeys = {}) {
        const clipName = `tts-${Date.now()}-${Math.random().toString(36).substring(7)}.mp3`;
        const filePath = path_1.default.join(this.tempDir, clipName);
        try {
            switch (provider.toLowerCase()) {
                case 'capcut':
                    return await this.generateFreeTts(text, filePath, options);
                case 'google':
                    return await this.generateGoogleCloudTts(text, voice, filePath, options, apiKeys.google);
                case 'openai':
                    return await this.generateOpenAiTts(text, voice, filePath, options, apiKeys.openai);
                case 'elevenlabs':
                    return await this.generateElevenLabsTts(text, voice, filePath, options, apiKeys.elevenlabs);
                default:
                    return await this.generateFreeTts(text, filePath, options);
            }
        }
        catch (error) {
            console.error(`[TTS Service] Error with provider ${provider}:`, error);
            // Fallback to free TTS if a paid service fails, ensuring the rendering never crashes!
            try {
                return await this.generateFreeTts(text, filePath, options);
            }
            catch (fallbackError) {
                throw new Error(`TTS failed on main and fallback: ${error}`);
            }
        }
    }
    /**
     * Free public TTS engine (acts as the default keyless CapCut option)
     * It uses a robust public Google Translate API that does not require any credentials.
     */
    async generateFreeTts(text, filePath, options) {
        // Translate Vietnamese speech endpoint
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=${encodeURIComponent(text)}`;
        const response = await (0, axios_1.default)({
            method: 'get',
            url: url,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        fs_1.default.writeFileSync(filePath, response.data);
        // In a real environment, if options.speed !== 1.0, we could run a fast FFmpeg pass
        // to adjust speed, but we can also adjust it in the main AudioEngine during mix.
        return filePath;
    }
    async generateGoogleCloudTts(text, voice, filePath, options, apiKey) {
        const key = apiKey || process.env.GOOGLE_API_KEY;
        if (!key)
            throw new Error("Google Cloud API Key is missing!");
        const response = await axios_1.default.post(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
            input: { text },
            voice: { languageCode: 'vi-VN', name: voice || 'vi-VN-Wavenet-A' },
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: options.speed || 1.0,
                pitch: options.pitch || 0.0
            }
        });
        const audioContent = response.data.audioContent;
        fs_1.default.writeFileSync(filePath, Buffer.from(audioContent, 'base64'));
        return filePath;
    }
    async generateOpenAiTts(text, voice, filePath, options, apiKey) {
        const key = apiKey || process.env.OPENAI_API_KEY;
        if (!key)
            throw new Error("OpenAI API Key is missing!");
        const response = await (0, axios_1.default)({
            method: 'post',
            url: 'https://api.openai.com/v1/audio/speech',
            data: {
                model: 'tts-1',
                input: text,
                voice: voice || 'alloy',
                speed: options.speed || 1.0
            },
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer'
        });
        fs_1.default.writeFileSync(filePath, response.data);
        return filePath;
    }
    async generateElevenLabsTts(text, voice, filePath, options, apiKey) {
        const key = apiKey || process.env.ELEVENLABS_API_KEY;
        if (!key)
            throw new Error("ElevenLabs API Key is missing!");
        const voiceId = voice || '21m00Tcm4TlvDq8ikWAM'; // default Rachel voice
        const response = await (0, axios_1.default)({
            method: 'post',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            data: {
                text: text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            },
            headers: {
                'xi-api-key': key,
                'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer'
        });
        fs_1.default.writeFileSync(filePath, response.data);
        return filePath;
    }
    async clearCache() {
        if (fs_1.default.existsSync(this.tempDir)) {
            fs_1.default.rmSync(this.tempDir, { recursive: true, force: true });
            fs_1.default.mkdirSync(this.tempDir, { recursive: true });
        }
    }
}
exports.TtsService = TtsService;
