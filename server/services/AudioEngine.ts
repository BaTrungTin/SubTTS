import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  attachFinalGap,
  buildSyncPlan,
  type ParsedSubtitle,
  type SyncPlan,
  type SyncPlanItem,
} from './SpeechSyncPlanner';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
  if (fs.existsSync(ffprobePath)) {
    ffmpeg.setFfprobePath(ffprobePath);
  }
}

export interface SubtitleItem {
  id: string;
  start: string;
  end: string;
  text: string;
}

export class AudioEngine {
  private tempDir = path.join(os.tmpdir(), 'vibe-audio-mix');
  private tempCounter = 0;

  constructor() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private tempPath(prefix: string, ext: string): string {
    this.tempCounter += 1;
    return path.join(this.tempDir, `${prefix}-${this.tempCounter}.${ext}`);
  }

  private clampSegment(start: number, duration: number, videoDuration: number): { start: number; duration: number } | null {
    if (!Number.isFinite(start) || !Number.isFinite(duration) || videoDuration <= 0) return null;
    const safeStart = Math.max(0, Math.min(start, Math.max(0, videoDuration - 0.1)));
    const maxDur = videoDuration - safeStart;
    const safeDur = Math.min(Math.max(duration, 0.1), maxDur);
    if (safeDur < 0.1) return null;
    return { start: safeStart, duration: safeDur };
  }

  /** Apply user TTS speed setting (1.0 = normal, 1.2 = faster). */
  async adjustSpeechSpeed(inputPath: string, speed: number, outputPath: string): Promise<string> {
    if (speed <= 0) return inputPath;
    return this.adjustAudioSpeed(inputPath, speed, outputPath);
  }

  async getDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.format.duration || 0);
      });
    });
  }

  async renderFinalVideo(
    videoPath: string,
    subtitles: SubtitleItem[],
    audioClips: string[],
    mixing: { keepOriginal: boolean; ai: number; bg: number; voice: number },
    mode: string,
    outputPath: string,
    onProgress: (progress: number, log: string) => void
  ): Promise<string> {
    onProgress(0.5, 'Analyzing TTS clips and subtitle timeline...');

    const parsedSubtitles: ParsedSubtitle[] = subtitles.map((sub, i) => {
      const start = this.timeToSeconds(sub.start);
      const end = this.timeToSeconds(sub.end);
      return {
        id: sub.id,
        start,
        end,
        duration: Math.max(0.05, end - start),
        clipPath: audioClips[i],
      };
    });

    const ttsDurations: number[] = [];
    for (let i = 0; i < parsedSubtitles.length; i++) {
      ttsDurations.push(await this.getDuration(audioClips[i]));
    }

    const syncMode = mode === 'video-priority' ? 'video-priority' : 'hybrid';
    let plan = buildSyncPlan(parsedSubtitles, ttsDurations, syncMode);
    const videoDuration = await this.getDuration(videoPath);
    plan = attachFinalGap(plan, videoDuration);

    onProgress(
      0.52,
      `Sync plan: ${plan.items.length} lines · stretch ${plan.stats.stretchedSegments} · speed-up ${plan.stats.spedUpSegments} · overlap fixes ${plan.stats.overlapFixes}`
    );

    onProgress(0.55, 'Preparing speech clips (speed-fit, trim, no overlap)...');
    for (let i = 0; i < plan.items.length; i++) {
      const item = plan.items[i];
      const preparedPath = this.tempPath(`speech-${i}`, 'mp3');
      item.adjustedTtsPath = await this.prepareSpeechClip(
        item.ttsPath,
        item.ttsSpeedFactor,
        syncMode === 'hybrid' ? item.ttsDuration : item.outputDuration,
        preparedPath
      );
      onProgress(
        0.55 + 0.1 * (i / plan.items.length),
        `Prepared speech #${i + 1}/${plan.items.length} (${item.ttsDuration.toFixed(2)}s → slot ${item.outputDuration.toFixed(2)}s)`
      );
    }

    if (syncMode === 'video-priority') {
      onProgress(0.68, 'Mode: Video Priority — fitting speech into subtitle slots without overlap...');
      return this.mixVideoPriority(videoPath, plan, mixing, outputPath, onProgress);
    }

    onProgress(0.68, 'Mode: Hybrid — stretching video segments to match speech duration...');
    return this.mixHybridStretch(videoPath, videoDuration, plan, mixing, outputPath, onProgress);
  }

  private async prepareSpeechClip(
    inputPath: string,
    speedFactor: number,
    targetDuration: number,
    outputPath: string
  ): Promise<string> {
    const safeTarget = Math.max(0.1, targetDuration);
    const tempSpeedPath =
      speedFactor > 1.01 ? this.tempPath('spd', 'mp3') : inputPath;

    if (speedFactor > 1.01) {
      await this.adjustAudioSpeed(inputPath, speedFactor, tempSpeedPath);
    }

    return this.trimAndPadAudio(tempSpeedPath, safeTarget, outputPath);
  }

  private trimAndPadAudio(inputPath: string, targetDuration: number, outputPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters([
          `atrim=0:${targetDuration.toFixed(3)}`,
          `apad=whole_dur=${targetDuration.toFixed(3)}`,
        ])
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }

  private adjustAudioSpeed(inputPath: string, factor: number, outputPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const safeFactor = Math.max(0.5, Math.min(factor, 2.5));
      let filter = '';
      if (safeFactor > 2.0) {
        filter = 'atempo=2.0';
      } else if (safeFactor < 0.5) {
        filter = 'atempo=0.5';
      } else {
        filter = `atempo=${safeFactor}`;
      }

      ffmpeg(inputPath)
        .audioFilters(filter)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }

  private async mixVideoPriority(
    videoPath: string,
    plan: SyncPlan,
    mixing: { keepOriginal: boolean; ai: number; bg: number; voice: number },
    outputPath: string,
    onProgress: (progress: number, log: string) => void
  ): Promise<string> {
    onProgress(0.75, 'Mixing synchronized speech onto original video...');
    return this.overlaySpeechClips(videoPath, plan.items, mixing, outputPath, false);
  }

  private async mixHybridStretch(
    videoPath: string,
    videoDuration: number,
    plan: SyncPlan,
    mixing: { keepOriginal: boolean; ai: number; bg: number; voice: number },
    outputPath: string,
    onProgress: (progress: number, log: string) => void
  ): Promise<string> {
    const segmentFiles: string[] = [];

    onProgress(0.7, 'Cutting and stretching video segments...');

    for (const gap of plan.gaps) {
      const window = this.clampSegment(gap.originalStart, gap.duration, videoDuration);
      if (!window) continue;
      const gapPath = this.tempPath('gap', 'mp4');
      await this.extractVideoSegment(videoPath, window.start, window.duration, gapPath, true);
      segmentFiles.push(gapPath);
    }

    for (let i = 0; i < plan.items.length; i++) {
      const item = plan.items[i];
      const window = this.clampSegment(item.originalStart, item.originalSlotDuration, videoDuration);
      if (!window) {
        onProgress(0.7 + 0.08 * (i / plan.items.length), `Skip segment #${i + 1}: ngoài phạm vi video`);
        continue;
      }

      const subPath = this.tempPath(`sub-${i}`, 'mp4');
      await this.extractVideoSegment(videoPath, window.start, window.duration, subPath, true);

      if (item.videoStretchFactor > 1.01) {
        const stretchPath = this.tempPath(`stretch-${i}`, 'mp4');
        onProgress(
          0.7 + 0.08 * (i / plan.items.length),
          `Stretch segment #${i + 1}: ${window.duration.toFixed(2)}s → ${item.outputDuration.toFixed(2)}s (×${item.videoStretchFactor.toFixed(2)})`
        );
        await this.stretchVideoSegment(subPath, item.videoStretchFactor, item.outputDuration, stretchPath);
        segmentFiles.push(stretchPath);
      } else {
        segmentFiles.push(subPath);
      }
    }

    if (plan.finalGap) {
      const window = this.clampSegment(plan.finalGap.originalStart, plan.finalGap.duration, videoDuration);
      if (window) {
        const finalGapPath = this.tempPath('gap-final', 'mp4');
        await this.extractVideoSegment(videoPath, window.start, window.duration, finalGapPath, true);
        segmentFiles.push(finalGapPath);
      }
    }

    if (segmentFiles.length === 0) {
      throw new Error('Không tạo được segment video hợp lệ — kiểm tra timestamp phụ đề và độ dài video.');
    }

    onProgress(0.82, `Merging ${segmentFiles.length} video segments...`);
    const mergedVideoPath = this.tempPath('merged-video', 'mp4');
    await this.concatenateVideos(segmentFiles, mergedVideoPath);

    onProgress(0.88, 'Overlaying synchronized dubbing audio...');
    return this.overlaySpeechClips(mergedVideoPath, plan.items, mixing, outputPath, true);
  }

  private overlaySpeechClips(
    videoPath: string,
    items: SyncPlanItem[],
    mixing: { keepOriginal: boolean; ai: number; bg: number; voice: number },
    outputPath: string,
    reencodeVideo: boolean
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = ffmpeg(videoPath);
      const speechClips = items.map((item) => item.adjustedTtsPath || item.ttsPath);

      speechClips.forEach((clip) => command.input(clip));

      const filterComplex: string[] = [];
      const amixInputs: string[] = [];
      const volume = (mixing.ai || 100) / 100;

      let audioCount = 1;
      items.forEach((item) => {
        const delayMs = Math.max(0, Math.round(item.outputStart * 1000));
        filterComplex.push(
          `[${audioCount}:a]adelay=${delayMs}|${delayMs},volume=${volume}[a${audioCount}]`
        );
        amixInputs.push(`[a${audioCount}]`);
        audioCount++;
      });

      if (mixing.keepOriginal) {
        const bgVol = (mixing.bg || 20) / 100;
        filterComplex.push(`[0:a]volume=${bgVol}[bg_aud]`);
        amixInputs.unshift(`[bg_aud]`);
      }

      filterComplex.push(
        `${amixInputs.join('')}amix=inputs=${amixInputs.length}:duration=longest:dropout_transition=0[mix_out]`
      );

      const outputOptions = reencodeVideo
        ? ['-map 0:v', '-map [mix_out]', '-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-b:a 192k']
        : ['-c:v copy', '-map 0:v', '-map [mix_out]', '-c:a aac', '-b:a 192k'];

      command
        .complexFilter(filterComplex)
        .outputOptions(outputOptions)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }

  private extractVideoSegment(
    videoPath: string,
    start: number,
    duration: number,
    outputPath: string,
    keepAudio: boolean
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmd = ffmpeg(videoPath)
        .setStartTime(start)
        .setDuration(duration)
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-movflags +faststart',
          ...(keepAudio ? ['-c:a aac', '-b:a 128k'] : ['-an']),
        ]);

      cmd
        .on('end', () => {
          if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
            reject(new Error(`Segment rỗng: ${outputPath}`));
            return;
          }
          resolve(outputPath);
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  private stretchVideoSegment(
    inputPath: string,
    factor: number,
    targetDuration: number,
    outputPath: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const safeFactor = Math.max(1.01, Math.min(factor, 12));
      const safeDuration = Math.max(0.15, targetDuration);

      ffmpeg(inputPath)
        .videoFilters(`setpts=${safeFactor.toFixed(4)}*PTS`)
        .outputOptions([
          '-an',
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-movflags +faststart',
          `-t ${safeDuration.toFixed(3)}`,
        ])
        .on('end', () => {
          if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
            reject(new Error(`Stretch segment rỗng (×${safeFactor.toFixed(2)}): ${outputPath}`));
            return;
          }
          resolve(outputPath);
        })
        .on('error', (err) => {
          reject(new Error(`Stretch video thất bại (×${safeFactor.toFixed(2)}): ${err.message}`));
        })
        .save(outputPath);
    });
  }

  private concatenateVideos(filePaths: string[], outputPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const listFilePath = this.tempPath('filelist', 'txt');
      const listContent = filePaths.map((fp) => `file '${fp.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(listFilePath, listContent, 'utf-8');

      ffmpeg()
        .input(listFilePath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-b:a 128k'])
        .on('end', () => resolve(outputPath))
        .on('error', (err) => {
          reject(new Error(`Ghép video thất bại: ${err.message}`));
        })
        .save(outputPath);
    });
  }

  private timeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':');
    const secondsParts = parts[2].split(',');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseInt(secondsParts[0], 10);
    const ms = parseInt(secondsParts[1], 10);
    return hours * 3600 + minutes * 60 + seconds + ms / 1000;
  }

  async clearCache() {
    this.tempCounter = 0;
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }
}
