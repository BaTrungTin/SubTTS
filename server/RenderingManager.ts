import path from 'path';
import os from 'os';
import { TtsService } from './services/TtsService';
import { AudioEngine } from './services/AudioEngine';

export class RenderingManager {
  private tts = new TtsService();
  private audio = new AudioEngine();

  async processDubbing(
    params: {
      videoPath: string;
      subtitles: any[];
      voiceSettings: any[];
      mixing: any;
      mode: string;
      outputPath: string;
      apiKeys?: { google?: string; openai?: string; elevenlabs?: string };
    },
    onProgress: (progress: number, log: string) => void
  ): Promise<string> {
    try {
      onProgress(0.05, "Initializing rendering pipeline and clearing cache...");
      await this.tts.clearCache();
      await this.audio.clearCache();

      // 1. Generate TTS Clips sequentially
      const audioClips: string[] = [];
      const totalSubs = params.subtitles.length;

      onProgress(0.1, `Starting Voice Synthesis. Total subtitles to synthesize: ${totalSubs}`);

      for (let i = 0; i < totalSubs; i++) {
        const sub = params.subtitles[i];
        
        // Dynamic voice assignment. Supports alternating between Giọng 1, 2, 3 based on speaker, or index
        const voiceIdx = i % params.voiceSettings.length;
        const setting = params.voiceSettings[voiceIdx];

        onProgress(
          0.1 + 0.4 * (i / totalSubs),
          `Synthesizing voice lồng tiếng for sub #${i + 1}/${totalSubs}... [${setting.provider}]`
        );

        const clipPath = await this.tts.generateSpeech(
          sub.text,
          setting.provider,
          setting.voice,
          {
            speed: setting.speed || 1.0,
            pitch: setting.pitch || 0,
            volume: setting.volume || 100
          },
          params.apiKeys
        );

        let finalClipPath = clipPath;
        const userSpeed = setting.speed || 1.0;
        if (userSpeed !== 1.0 && userSpeed > 0) {
          const adjustedPath = path.join(
            os.tmpdir(),
            'vibe-tts-clips',
            `speed-${i}-${Date.now()}.mp3`
          );
          finalClipPath = await this.audio.adjustSpeechSpeed(clipPath, userSpeed, adjustedPath);
        }

        audioClips.push(finalClipPath);
      }

      onProgress(0.5, "Voice synthesis complete! Initiating final media mixing and alignment...");

      // 2. Render and Mix (Video Priority or Hybrid Auto-Stretch)
      const finalVideoPath = await this.audio.renderFinalVideo(
        params.videoPath,
        params.subtitles,
        audioClips,
        params.mixing,
        params.mode,
        params.outputPath,
        onProgress
      );

      onProgress(1.0, "Dubbing and rendering completed successfully! Enjoy your new video.");
      return finalVideoPath;
    } catch (error: any) {
      console.error("[Rendering Manager] Error during rendering pipeline:", error);
      onProgress(1.0, `Error during rendering: ${error.message || error}`);
      throw error;
    }
  }
}
