"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SSE_CONTENT_BYTES = exports.LARGE_SRT_BYTES = void 0;
exports.parseSrtContent = parseSrtContent;
exports.readSrtFile = readSrtFile;
exports.formatFileSize = formatFileSize;
exports.isValidTranslation = isValidTranslation;
exports.countValidTranslations = countValidTranslations;
exports.timeKey = timeKey;
exports.buildExistingTranslationsFromViFile = buildExistingTranslationsFromViFile;
const fs_1 = __importDefault(require("fs"));
const SRT_REGEX = /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|\r?\n$|$)/g;
/** Files above this size use server-side translation without loading all lines into the browser. */
exports.LARGE_SRT_BYTES = 5 * 1024 * 1024;
/** SSE responses larger than this are written to disk and returned as a file path. */
exports.MAX_SSE_CONTENT_BYTES = 2 * 1024 * 1024;
function parseSrtContent(content) {
    if (content == null || typeof content !== 'string') {
        throw new Error('Nội dung SRT không hợp lệ — hãy import lại file phụ đề.');
    }
    if (!content.trim()) {
        throw new Error('File SRT trống hoặc không đọc được nội dung.');
    }
    const matches = [...content.matchAll(SRT_REGEX)];
    return matches.map((m) => ({
        id: m[1],
        start: m[2],
        end: m[3],
        text: m[4].replace(/\r?\n/g, ' ').trim(),
    }));
}
function readSrtFile(filePath) {
    const content = fs_1.default.readFileSync(filePath, 'utf-8');
    return parseSrtContent(content);
}
function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}
function countCjkChars(text) {
    return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
}
function isMostlyChinese(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return false;
    const letters = trimmed.replace(/\s+/g, '').length;
    if (letters === 0)
        return false;
    return countCjkChars(trimmed) / letters >= 0.35;
}
function isValidTranslation(original, translated) {
    const orig = original?.trim() || '';
    const trans = translated?.trim() || '';
    if (!orig || !trans)
        return false;
    if (trans === orig)
        return false;
    if (isMostlyChinese(trans))
        return false;
    return true;
}
function countValidTranslations(originals, translated) {
    return originals.filter((sub, i) => isValidTranslation(sub.text, translated[i]?.text || '')).length;
}
function timeKey(start, end) {
    return `${start.trim()}|${end.trim()}`;
}
/** Ghép bản dịch VI vào phụ đề gốc theo mốc thời gian — trả map index → text đã dịch hợp lệ */
function buildExistingTranslationsFromViFile(chineseSubs, viSubs) {
    const byExact = new Map();
    const byStart = new Map();
    for (const v of viSubs) {
        const text = v.text?.trim();
        if (!text)
            continue;
        byExact.set(timeKey(v.start, v.end), text);
        if (!byStart.has(v.start.trim())) {
            byStart.set(v.start.trim(), text);
        }
    }
    const map = {};
    chineseSubs.forEach((sub, i) => {
        const candidate = byExact.get(timeKey(sub.start, sub.end)) ?? byStart.get(sub.start.trim()) ?? '';
        if (isValidTranslation(sub.text, candidate)) {
            map[i] = candidate.trim();
        }
    });
    return map;
}
