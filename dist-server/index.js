"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
const RenderingManager_1 = require("./RenderingManager");
const TranslationService_1 = require("./services/TranslationService");
const srtUtils_1 = require("./srtUtils");
const app = (0, express_1.default)();
const PORT = 5000;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
if (ffmpeg_static_1.default) {
    fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_static_1.default);
    const ffprobePath = ffmpeg_static_1.default.replace('ffmpeg', 'ffprobe');
    if (fs_1.default.existsSync(ffprobePath)) {
        fluent_ffmpeg_1.default.setFfprobePath(ffprobePath);
    }
}
const renderer = new RenderingManager_1.RenderingManager();
const translator = new TranslationService_1.TranslationService();
let ocrReadyCache = null;
function checkOcrRuntimeReady() {
    if (ocrReadyCache !== null)
        return ocrReadyCache;
    try {
        const { execSync } = require('child_process');
        execSync('python -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec(\'paddleocr\') else 1)"', {
            encoding: 'utf-8',
            timeout: 8000,
            stdio: 'pipe',
        });
        ocrReadyCache = true;
    }
    catch {
        ocrReadyCache = false;
    }
    return ocrReadyCache;
}
app.get('/api/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'vibe-studio-server',
        port: PORT,
        version: 2,
        features: ['merge-vi-progress', 'translate-srt-file', 'large-srt', 'paddleocr-extract'],
        ocrRuntimeReady: checkOcrRuntimeReady(),
    });
});
// API: List available drives (Windows)
app.get('/api/drives', (_req, res) => {
    if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        try {
            // WMIC is removed on recent Windows builds; use PowerShell instead.
            const output = execSync('powershell -NoProfile -Command "[System.IO.DriveInfo]::GetDrives() | Select-Object -ExpandProperty Name"', { encoding: 'utf-8' });
            const drives = output.split('\n')
                .map((l) => l.trim())
                .filter((l) => /^[A-Z]:\\?$/.test(l))
                .map((d) => ({ name: d.endsWith('\\') ? d : `${d}\\`, type: 'drive' }));
            res.json(drives.length > 0 ? drives : [{ name: 'C:\\', type: 'drive' }, { name: 'D:\\', type: 'drive' }]);
        }
        catch {
            res.json([{ name: 'C:\\', type: 'drive' }, { name: 'D:\\', type: 'drive' }]);
        }
    }
    else {
        res.json([{ name: '/', type: 'drive' }]);
    }
});
// API: List files and folders in a directory
app.get('/api/list-dir', (req, res) => {
    const dirPath = req.query.path;
    if (!dirPath)
        return res.status(400).json({ error: 'Missing path' });
    try {
        if (!fs_1.default.existsSync(dirPath))
            return res.status(404).json({ error: 'Path not found' });
        const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
        const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv'];
        const srtExts = ['.srt', '.ass', '.ssa', '.vtt'];
        const items = [];
        for (const entry of entries) {
            // Skip hidden / system files
            if (entry.name.startsWith('.') || entry.name.startsWith('$'))
                continue;
            const fullPath = path_1.default.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                items.push({ name: entry.name, path: fullPath, type: 'folder' });
            }
            else {
                const ext = path_1.default.extname(entry.name).toLowerCase();
                if (videoExts.includes(ext)) {
                    let size = 0;
                    try {
                        size = fs_1.default.statSync(fullPath).size;
                    }
                    catch { }
                    items.push({ name: entry.name, path: fullPath, type: 'video', size });
                }
                else if (srtExts.includes(ext)) {
                    items.push({ name: entry.name, path: fullPath, type: 'subtitle' });
                }
            }
        }
        // Sort: folders first, then files
        items.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder')
                return -1;
            if (a.type !== 'folder' && b.type === 'folder')
                return 1;
            return a.name.localeCompare(b.name);
        });
        res.json(items);
    }
    catch (error) {
        res.status(500).json({ error: error.message || 'Cannot read directory' });
    }
});
// 0. Stream local video file to browser (supports Range requests for seeking)
app.get('/api/stream-video', (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !fs_1.default.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    const stat = fs_1.default.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    // Detect mime type based on extension
    const ext = path_1.default.extname(filePath).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.wmv': 'video/x-ms-wmv',
        '.webm': 'video/webm',
    };
    const contentType = mimeMap[ext] || 'video/mp4';
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const stream = fs_1.default.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
        });
        stream.pipe(res);
    }
    else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
        });
        fs_1.default.createReadStream(filePath).pipe(res);
    }
});
// 1. Get video metadata
app.post('/api/get-video-metadata', (req, res) => {
    const { videoPath } = req.body;
    if (!videoPath) {
        return res.status(400).json({ error: 'Missing videoPath' });
    }
    fluent_ffmpeg_1.default.ffprobe(videoPath, (err, metadata) => {
        if (err) {
            return res.status(500).json({ error: err.message || err });
        }
        const videoStream = metadata?.streams?.find(s => s.codec_type === 'video');
        res.json({
            duration: metadata?.format?.duration || 0,
            resolution: `${videoStream?.width || 0}x${videoStream?.height || 0}`,
            format: metadata?.format?.format_name || 'unknown',
        });
    });
});
// 2. Parse SRT file (large files return metadata only — translation reads from disk)
app.post('/api/parse-subtitles', (req, res) => {
    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: 'Missing filePath' });
    }
    try {
        if (!fs_1.default.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        const stat = fs_1.default.statSync(filePath);
        const subs = (0, srtUtils_1.readSrtFile)(filePath);
        if (subs.length === 0) {
            return res.status(400).json({ error: 'Không tìm thấy dòng phụ đề hợp lệ trong file SRT.' });
        }
        if (stat.size >= srtUtils_1.LARGE_SRT_BYTES) {
            return res.json({
                largeFile: true,
                filePath,
                lineCount: subs.length,
                fileSizeBytes: stat.size,
                fileSizeLabel: (0, srtUtils_1.formatFileSize)(stat.size),
            });
        }
        res.json(subs);
    }
    catch (error) {
        res.status(500).json({ error: error.message || error });
    }
});
// 2b. Merge partial VI SRT into Chinese source (resume / dịch sót)
app.post('/api/merge-vi-progress', (req, res) => {
    const { sourcePath, viPath } = req.body;
    if (!sourcePath || !viPath) {
        return res.status(400).json({ error: 'Missing sourcePath or viPath' });
    }
    try {
        if (!fs_1.default.existsSync(sourcePath)) {
            return res.status(404).json({ error: `Không tìm thấy SRT gốc: ${sourcePath}` });
        }
        if (!fs_1.default.existsSync(viPath)) {
            return res.status(404).json({ error: `Không tìm thấy SRT đã dịch: ${viPath}` });
        }
        const chinese = (0, srtUtils_1.readSrtFile)(sourcePath);
        const vi = (0, srtUtils_1.readSrtFile)(viPath);
        const existingTranslations = (0, srtUtils_1.buildExistingTranslationsFromViFile)(chinese, vi);
        const validCount = Object.keys(existingTranslations).length;
        res.json({
            totalCount: chinese.length,
            validCount,
            missedCount: chinese.length - validCount,
            existingTranslations,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message || error });
    }
});
function isPathUnderDir(filePath, allowedDir) {
    const normalizedFile = path_1.default.resolve(filePath);
    const normalizedDir = path_1.default.resolve(allowedDir);
    return normalizedFile.startsWith(normalizedDir + path_1.default.sep) || normalizedFile === normalizedDir;
}
// Download translated SRT (or other temp output) from server
app.get('/api/download-file', (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !fs_1.default.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    if (!isPathUnderDir(filePath, os_1.default.tmpdir())) {
        return res.status(403).json({ error: 'Download not allowed for this path' });
    }
    const filename = path_1.default.basename(filePath);
    res.download(filePath, filename);
});
// 3. Save SRT content to a temp file and return path
app.post('/api/save-temp-srt', (req, res) => {
    const { srtContent } = req.body;
    const tempPath = path_1.default.join(os_1.default.tmpdir(), `temp-sub-${Date.now()}.srt`);
    try {
        fs_1.default.writeFileSync(tempPath, srtContent, 'utf-8');
        res.json({ filePath: tempPath });
    }
    catch (error) {
        res.status(500).json({ error: error.message || error });
    }
});
// 4. Start OCR with Real-time SSE Log streaming
app.post('/api/start-ocr', (req, res) => {
    const { videoPath, xMin, yMin, xMax, yMax, ocrProfile } = req.body;
    const profile = ocrProfile === 'fast' || ocrProfile === 'balanced' || ocrProfile === 'accurate'
        ? ocrProfile
        : 'accurate';
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    const tempSrtPath = path_1.default.join(os_1.default.tmpdir(), `ocr-sub-${Date.now()}.srt`);
    const pythonServicesDir = path_1.default.join(__dirname, '../python_services');
    const pythonScriptPath = path_1.default.join(pythonServicesDir, 'ocr_processor.py');
    const pyProcess = (0, child_process_1.spawn)('python', [
        pythonScriptPath,
        videoPath,
        xMin.toString(),
        yMin.toString(),
        xMax.toString(),
        yMax.toString(),
        tempSrtPath,
        profile,
    ], {
        env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            PYTHONPATH: [pythonServicesDir, process.env.PYTHONPATH].filter(Boolean).join(path_1.default.delimiter),
        },
    });
    let errorOutput = '';
    const recentStdoutLines = [];
    pyProcess.stdout.on('data', (data) => {
        const lines = data.toString('utf8').split('\n');
        for (const line of lines) {
            if (!line.trim())
                continue;
            recentStdoutLines.push(line.trim());
            if (recentStdoutLines.length > 30)
                recentStdoutLines.shift();
            try {
                const parsed = JSON.parse(line.trim());
                res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            }
            catch (e) {
                // Raw print logs
                res.write(`data: ${JSON.stringify({ type: 'log', log: line.trim() })}\n\n`);
            }
        }
    });
    pyProcess.stderr.on('data', (data) => {
        errorOutput += data.toString('utf8');
    });
    pyProcess.on('close', (code) => {
        if (code !== 0) {
            const stdoutHint = recentStdoutLines
                .slice(-8)
                .join(' | ')
                .trim();
            const detail = (errorOutput || '').trim() || stdoutHint || 'Không có stderr/stdout chi tiết từ Python.';
            res.write(`data: ${JSON.stringify({ type: 'error', message: `Python exited with code ${code}. Error: ${detail}` })}\n\n`);
        }
        else {
            res.write(`data: ${JSON.stringify({ type: 'done', filePath: tempSrtPath })}\n\n`);
        }
        res.end();
    });
});
function resolveSrtContent(body) {
    const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
    if (filePath) {
        if (!fs_1.default.existsSync(filePath)) {
            throw new Error(`Không tìm thấy file SRT: ${filePath}`);
        }
        const content = fs_1.default.readFileSync(filePath, 'utf-8');
        if (!content.trim()) {
            throw new Error(`File SRT trống: ${filePath}`);
        }
        return content;
    }
    const srtContent = body.srtContent;
    if (typeof srtContent === 'string' && srtContent.trim()) {
        return srtContent;
    }
    throw new Error('Thiếu nội dung SRT — import lại file phụ đề (file lớn cần chọn file từ ổ đĩa, không refresh trang).');
}
// 5. Translate SRT with Gemini rotation pool SSE streaming
app.post('/api/translate-srt', async (req, res) => {
    const { srtContent, filePath, apiKeys, existingTranslations, provider, model, batchSize } = req.body;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    try {
        const contentToTranslate = resolveSrtContent({ srtContent, filePath });
        const isLargeJob = Buffer.byteLength(contentToTranslate, 'utf8') >= srtUtils_1.LARGE_SRT_BYTES;
        const result = await translator.translateSrt(contentToTranslate, apiKeys, (progress, log) => {
            res.write(`data: ${JSON.stringify({ type: 'progress', progress: Math.round(progress * 100), log })}\n\n`);
        }, {
            existingTranslations: existingTranslations || {},
            onBatchComplete: (updates) => {
                if (!isLargeJob) {
                    res.write(`data: ${JSON.stringify({ type: 'batch', updates })}\n\n`);
                }
            },
        }, {
            provider: provider || 'gemini',
            model,
            batchSize: typeof batchSize === 'number' ? batchSize : undefined,
        });
        const contentBytes = Buffer.byteLength(result.content, 'utf8');
        const useOutputFile = isLargeJob || contentBytes >= srtUtils_1.MAX_SSE_CONTENT_BYTES;
        let outputFilePath;
        if (useOutputFile) {
            outputFilePath = path_1.default.join(os_1.default.tmpdir(), `translated-${Date.now()}.srt`);
            fs_1.default.writeFileSync(outputFilePath, result.content, 'utf-8');
        }
        res.write(`data: ${JSON.stringify({
            type: 'done',
            content: useOutputFile ? '' : result.content,
            outputFilePath,
            partial: !result.isComplete,
            translatedCount: result.translatedCount,
            totalCount: result.totalCount,
        })}\n\n`);
        if (!result.isComplete) {
            const remaining = result.missedCount ?? result.totalCount - result.translatedCount;
            const message = result.quotaExhausted
                ? `Đã dịch ${result.translatedCount}/${result.totalCount} dòng. Hết quota Gemini hôm nay — còn ${remaining} dòng. ` +
                    `Bấm "Dịch sót" vào ngày mai (reset ~0h PT) hoặc chuyển OpenRouter. Thêm key cùng 1 tài khoản Google không tăng quota.`
                : `Đã dịch ${result.translatedCount}/${result.totalCount} dòng. Còn ${remaining} dòng sót — bấm "Dịch sót" (không cần đổi key).`;
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message,
                recoverable: true,
                quotaExhausted: result.quotaExhausted,
            })}\n\n`);
        }
    }
    catch (error) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || error })}\n\n`);
    }
    finally {
        res.end();
    }
});
// 6. Dubbing and rendering SSE streaming
app.post('/api/start-rendering', async (req, res) => {
    const { videoPath, subtitles, voiceSettings, mixing, mode, outputPath, apiKeys } = req.body;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    try {
        const finalOut = await renderer.processDubbing({
            videoPath,
            subtitles,
            voiceSettings,
            mixing,
            mode,
            outputPath,
            apiKeys
        }, (progress, log) => {
            res.write(`data: ${JSON.stringify({ type: 'progress', progress, log })}\n\n`);
        });
        res.write(`data: ${JSON.stringify({ type: 'done', filePath: finalOut })}\n\n`);
    }
    catch (error) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || error })}\n\n`);
    }
    finally {
        res.end();
    }
});
app.listen(PORT, () => {
    console.log(`[Vibe Studio Server] API running strictly at http://localhost:${PORT}`);
});
