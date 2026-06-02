import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { RenderingManager } from './RenderingManager';
import { TranslationService } from './services/TranslationService';
import {
  formatFileSize,
  LARGE_SRT_BYTES,
  MAX_SSE_CONTENT_BYTES,
  parseSrtContent,
  readSrtFile,
  buildExistingTranslationsFromViFile,
} from './srtUtils';

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
  if (fs.existsSync(ffprobePath)) {
    ffmpeg.setFfprobePath(ffprobePath);
  }
}

const renderer = new RenderingManager();
const translator = new TranslationService();

let ocrReadyCache: boolean | null = null;
let ocrEngineCache: Record<string, unknown> | null = null;

const OCR_PYTHON_MARKER = path.join(__dirname, '../python_services/.ocr-python-path');
const DEFAULT_PYTHON312 = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'Python',
  'Python312',
  'python.exe',
);

/** Python dùng cho OCR: ưu tiên 3.12 (PaddleOCR), không dùng 3.14 mặc định. */
function resolveOcrPython(): { command: string; prefixArgs: string[]; label: string } {
  const fromEnv = process.env.OCR_PYTHON?.trim();
  if (fromEnv) {
    return { command: fromEnv, prefixArgs: [], label: fromEnv };
  }

  if (fs.existsSync(OCR_PYTHON_MARKER)) {
    const fromFile = fs.readFileSync(OCR_PYTHON_MARKER, 'utf8').trim();
    if (fromFile && fs.existsSync(fromFile)) {
      return { command: fromFile, prefixArgs: [], label: fromFile };
    }
  }

  if (process.platform === 'win32') {
    if (fs.existsSync(DEFAULT_PYTHON312)) {
      return { command: DEFAULT_PYTHON312, prefixArgs: [], label: DEFAULT_PYTHON312 };
    }
    try {
      const { execSync } = require('child_process');
      execSync('py -3.12 -c "import sys"', { encoding: 'utf-8', timeout: 8000, stdio: 'pipe' });
      return { command: 'py', prefixArgs: ['-3.12'], label: 'py -3.12' };
    } catch {
      /* fall through */
    }
  }

  return { command: 'python', prefixArgs: [], label: 'python' };
}

function runOcrPythonJson(scriptName: string): Record<string, unknown> | null {
  const { execSync } = require('child_process');
  const pythonServicesDir = path.join(__dirname, '../python_services');
  const scriptPath = path.join(pythonServicesDir, scriptName);
  const { command, prefixArgs } = resolveOcrPython();
  try {
    const out = execSync([command, ...prefixArgs, scriptPath].map((a) => `"${a}"`).join(' '), {
      encoding: 'utf-8',
      timeout: 20000,
      stdio: 'pipe',
      shell: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONPATH: [pythonServicesDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    });
    return JSON.parse(out.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getOcrEngineInfo(): Record<string, unknown> {
  if (ocrEngineCache) return ocrEngineCache;
  const detected = runOcrPythonJson('detect_ocr_engine.py');
  const { label } = resolveOcrPython();
  ocrEngineCache = detected
    ? { ...detected, pythonCommand: label }
    : { engine: 'none', pythonCommand: label, message: 'Chưa cài OCR trên Python 3.12.' };
  return ocrEngineCache;
}

function checkOcrRuntimeReady(): boolean {
  if (ocrReadyCache !== null) return ocrReadyCache;
  const info = getOcrEngineInfo();
  ocrReadyCache = info.engine === 'paddle' || info.engine === 'easyocr';
  return ocrReadyCache;
}

app.get('/api/health', (_req, res) => {
  const ocr = getOcrEngineInfo();
  res.json({
    ok: true,
    service: 'vibe-studio-server',
    port: PORT,
    version: 2,
    features: ['merge-vi-progress', 'translate-srt-file', 'large-srt', 'paddleocr-extract'],
    ocrRuntimeReady: checkOcrRuntimeReady(),
    ocrEngine: ocr.engine,
    ocrPython: ocr.pythonCommand,
    ocrMessage: ocr.message,
  });
});

// API: List available drives (Windows)
app.get('/api/drives', (_req, res) => {
  if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    try {
      // WMIC is removed on recent Windows builds; use PowerShell instead.
      const output = execSync(
        'powershell -NoProfile -Command "[System.IO.DriveInfo]::GetDrives() | Select-Object -ExpandProperty Name"',
        { encoding: 'utf-8' }
      );
      const drives = output.split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => /^[A-Z]:\\?$/.test(l))
        .map((d: string) => ({ name: d.endsWith('\\') ? d : `${d}\\`, type: 'drive' }));
      res.json(drives.length > 0 ? drives : [{ name: 'C:\\', type: 'drive' }, { name: 'D:\\', type: 'drive' }]);
    } catch {
      res.json([{ name: 'C:\\', type: 'drive' }, { name: 'D:\\', type: 'drive' }]);
    }
  } else {
    res.json([{ name: '/', type: 'drive' }]);
  }
});

// API: List files and folders in a directory
app.get('/api/list-dir', (req, res) => {
  const dirPath = req.query.path as string;
  if (!dirPath) return res.status(400).json({ error: 'Missing path' });

  try {
    if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Path not found' });

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv'];
    const srtExts = ['.srt', '.ass', '.ssa', '.vtt'];

    const items = [];
    for (const entry of entries) {
      // Skip hidden / system files
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        items.push({ name: entry.name, path: fullPath, type: 'folder' });
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (videoExts.includes(ext)) {
          let size = 0;
          try { size = fs.statSync(fullPath).size; } catch {}
          items.push({ name: entry.name, path: fullPath, type: 'video', size });
        } else if (srtExts.includes(ext)) {
          items.push({ name: entry.name, path: fullPath, type: 'subtitle' });
        }
      }
    }

    // Sort: folders first, then files
    items.sort((a, b) => {
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      return a.name.localeCompare(b.name);
    });

    res.json(items);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Cannot read directory' });
  }
});

// 0. Stream local video file to browser (supports Range requests for seeking)
app.get('/api/stream-video', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // Detect mime type based on extension
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
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

    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// 1. Get video metadata
app.post('/api/get-video-metadata', (req, res) => {
  const { videoPath } = req.body;
  if (!videoPath) {
    return res.status(400).json({ error: 'Missing videoPath' });
  }

  ffmpeg.ffprobe(videoPath, (err, metadata) => {
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
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const subs = readSrtFile(filePath);

    if (subs.length === 0) {
      return res.status(400).json({ error: 'Không tìm thấy dòng phụ đề hợp lệ trong file SRT.' });
    }

    if (stat.size >= LARGE_SRT_BYTES) {
      return res.json({
        largeFile: true,
        filePath,
        lineCount: subs.length,
        fileSizeBytes: stat.size,
        fileSizeLabel: formatFileSize(stat.size),
      });
    }

    res.json(subs);
  } catch (error: any) {
    res.status(500).json({ error: error.message || error });
  }
});

// 2a. Gộp / lọc trùng SRT (OCR stutter) — ghi đè file gốc
app.post('/api/cleanup-srt', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Missing filePath' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    const { execSync } = require('child_process');
    const pythonServicesDir = path.join(__dirname, '../python_services');
    const scriptPath = path.join(pythonServicesDir, 'run_srt_cleanup.py');
    const { command, prefixArgs } = resolveOcrPython();
    const out = execSync(
      [command, ...prefixArgs, scriptPath, filePath, '0.82', '1.2']
        .map((a) => `"${a}"`)
        .join(' '),
      {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: 'pipe',
        shell: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONPATH: [pythonServicesDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        },
      },
    );
    const result = JSON.parse(out.trim()) as {
      before?: number;
      after?: number;
      merged?: number;
      duplicatePairs?: unknown[];
      duplicateCount?: number;
      remainingDuplicates?: number;
      error?: string;
    };
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }
    const subs = readSrtFile(filePath);
    res.json({
      before: result.before ?? subs.length,
      after: result.after ?? subs.length,
      merged: result.merged ?? 0,
      duplicatePairs: result.duplicatePairs ?? [],
      duplicateCount: result.duplicateCount ?? 0,
      remainingDuplicates: result.remainingDuplicates ?? 0,
      subtitles: subs,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

function runSrtPythonJson(scriptName: string, args: string[] = []): Record<string, unknown> | null {
  const { execSync } = require('child_process');
  const pythonServicesDir = path.join(__dirname, '../python_services');
  const scriptPath = path.join(pythonServicesDir, scriptName);
  const { command, prefixArgs } = resolveOcrPython();
  try {
    const out = execSync(
      [command, ...prefixArgs, scriptPath, ...args].map((a) => `"${a}"`).join(' '),
      {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: 'pipe',
        shell: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONPATH: [pythonServicesDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        },
      },
    );
    return JSON.parse(out.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// 2a2. Phân tích trùng (không ghi file)
app.post('/api/analyze-srt-duplicates', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Missing filePath' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const result = runSrtPythonJson('run_srt_analyze.py', [filePath]);
  if (!result) {
    return res.status(500).json({ error: 'Không phân tích được SRT.' });
  }
  res.json(result);
});

// 2b. Merge partial VI SRT into Chinese source (resume / dịch sót)
app.post('/api/merge-vi-progress', (req, res) => {
  const { sourcePath, viPath } = req.body;
  if (!sourcePath || !viPath) {
    return res.status(400).json({ error: 'Missing sourcePath or viPath' });
  }
  try {
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: `Không tìm thấy SRT gốc: ${sourcePath}` });
    }
    if (!fs.existsSync(viPath)) {
      return res.status(404).json({ error: `Không tìm thấy SRT đã dịch: ${viPath}` });
    }
    const chinese = readSrtFile(sourcePath);
    const vi = readSrtFile(viPath);
    const existingTranslations = buildExistingTranslationsFromViFile(chinese, vi);
    const validCount = Object.keys(existingTranslations).length;
    res.json({
      totalCount: chinese.length,
      validCount,
      missedCount: chinese.length - validCount,
      existingTranslations,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || error });
  }
});

function isPathUnderDir(filePath: string, allowedDir: string): boolean {
  const normalizedFile = path.resolve(filePath);
  const normalizedDir = path.resolve(allowedDir);
  return normalizedFile.startsWith(normalizedDir + path.sep) || normalizedFile === normalizedDir;
}

// Download translated SRT (or other temp output) from server
app.get('/api/download-file', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (!isPathUnderDir(filePath, os.tmpdir())) {
    return res.status(403).json({ error: 'Download not allowed for this path' });
  }

  const filename = path.basename(filePath);
  res.download(filePath, filename);
});

// 3. Save SRT content to a temp file and return path
app.post('/api/save-temp-srt', (req, res) => {
  const { srtContent } = req.body;
  const tempPath = path.join(os.tmpdir(), `temp-sub-${Date.now()}.srt`);
  try {
    fs.writeFileSync(tempPath, srtContent, 'utf-8');
    res.json({ filePath: tempPath });
  } catch (error: any) {
    res.status(500).json({ error: error.message || error });
  }
});

// 4. Start OCR with Real-time SSE Log streaming
app.post('/api/start-ocr', (req, res) => {
  const { videoPath, xMin, yMin, xMax, yMax, ocrProfile, ocrDownscale720 } = req.body;
  const downscale720 = ocrDownscale720 !== false;
  const profile =
    ocrProfile === 'fast' || ocrProfile === 'balanced' || ocrProfile === 'accurate'
      ? ocrProfile
      : 'accurate';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const tempSrtPath = path.join(os.tmpdir(), `ocr-sub-${Date.now()}.srt`);
  const pythonServicesDir = path.join(__dirname, '../python_services');
  const pythonScriptPath = path.join(pythonServicesDir, 'ocr_processor.py');
  const { command, prefixArgs } = resolveOcrPython();

  const pyProcess = spawn(
    command,
    [
      ...prefixArgs,
      pythonScriptPath,
      videoPath,
      xMin.toString(),
      yMin.toString(),
      xMax.toString(),
      yMax.toString(),
      tempSrtPath,
      profile,
      downscale720 ? '1' : '0',
    ],
    {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        FLAGS_use_mkldnn: '0',
        FLAGS_use_dnnl: '0',
        FLAGS_enable_onednn: '0',
        FLAGS_use_onednn: '0',
        OMP_NUM_THREADS: '1',
        PYTHONPATH: [pythonServicesDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    },
  );

  let errorOutput = '';
  const recentStdoutLines: string[] = [];

  pyProcess.stdout.on('data', (data) => {
    const lines = data.toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      recentStdoutLines.push(line.trim());
      if (recentStdoutLines.length > 30) recentStdoutLines.shift();
      try {
        const parsed = JSON.parse(line.trim());
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch (e) {
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
    } else {
      res.write(`data: ${JSON.stringify({ type: 'done', filePath: tempSrtPath })}\n\n`);
    }
    res.end();
  });
});

function resolveSrtContent(body: {
  srtContent?: unknown;
  filePath?: unknown;
}): string {
  const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Không tìm thấy file SRT: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) {
      throw new Error(`File SRT trống: ${filePath}`);
    }
    return content;
  }

  const srtContent = body.srtContent;
  if (typeof srtContent === 'string' && srtContent.trim()) {
    return srtContent;
  }

  throw new Error(
    'Thiếu nội dung SRT — import lại file phụ đề (file lớn cần chọn file từ ổ đĩa, không refresh trang).'
  );
}

// 5. Translate SRT with Gemini rotation pool SSE streaming
app.post('/api/translate-srt', async (req, res) => {
  const { srtContent, filePath, apiKeys, existingTranslations, provider, model, batchSize } =
    req.body;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    const contentToTranslate = resolveSrtContent({ srtContent, filePath });
    const isLargeJob = Buffer.byteLength(contentToTranslate, 'utf8') >= LARGE_SRT_BYTES;

    const result = await translator.translateSrt(
      contentToTranslate,
      apiKeys,
      (progress, log) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', progress: Math.round(progress * 100), log })}\n\n`);
      },
      {
        existingTranslations: existingTranslations || {},
        onBatchComplete: (updates) => {
          if (!isLargeJob) {
            res.write(`data: ${JSON.stringify({ type: 'batch', updates })}\n\n`);
          }
        },
      },
      {
        provider: provider || 'gemini',
        model,
        batchSize: typeof batchSize === 'number' ? batchSize : undefined,
      }
    );

    const contentBytes = Buffer.byteLength(result.content, 'utf8');
    const useOutputFile = isLargeJob || contentBytes >= MAX_SSE_CONTENT_BYTES;
    let outputFilePath: string | undefined;

    if (useOutputFile) {
      outputFilePath = path.join(os.tmpdir(), `translated-${Date.now()}.srt`);
      fs.writeFileSync(outputFilePath, result.content, 'utf-8');
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
  } catch (error: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || error })}\n\n`);
  } finally {
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
    const finalOut = await renderer.processDubbing(
      {
        videoPath,
        subtitles,
        voiceSettings,
        mixing,
        mode,
        outputPath,
        apiKeys
      },
      (progress, log) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', progress, log })}\n\n`);
      }
    );
    res.write(`data: ${JSON.stringify({ type: 'done', filePath: finalOut })}\n\n`);
  } catch (error: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || error })}\n\n`);
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[Vibe Studio Server] API running strictly at http://localhost:${PORT}`);
});
