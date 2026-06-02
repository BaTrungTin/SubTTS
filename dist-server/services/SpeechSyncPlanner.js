"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSyncPlan = buildSyncPlan;
exports.attachFinalGap = attachFinalGap;
const MIN_GAP_SEC = 0.08;
const MAX_SPEED_UP = 2.5;
const MIN_HYBRID_SLOT_SEC = 0.25;
const MAX_VIDEO_STRETCH = 12;
function buildSyncPlan(subtitles, ttsDurations, mode) {
    const items = [];
    const gaps = [];
    let outputCursor = 0;
    let lastOriginalEnd = 0;
    let stretchedSegments = 0;
    let spedUpSegments = 0;
    let overlapFixes = 0;
    for (let i = 0; i < subtitles.length; i++) {
        const sub = subtitles[i];
        const ttsDur = Math.max(0.05, ttsDurations[i] || 0.05);
        const nextStart = i < subtitles.length - 1 ? subtitles[i + 1].start : Infinity;
        if (sub.start > lastOriginalEnd + 0.001) {
            const gapDur = sub.start - lastOriginalEnd;
            gaps.push({
                originalStart: lastOriginalEnd,
                duration: gapDur,
                outputStart: outputCursor,
            });
            outputCursor += gapDur;
        }
        const rawSlot = Math.max(0.05, sub.end - sub.start);
        let originalSlotDuration = rawSlot;
        let availableSpeechWindow = rawSlot;
        // Chỉ thu hẹp slot cho video-priority. Hybrid cần đủ khung hình gốc để tránh stretch cực đoan.
        if (mode === 'video-priority' && nextStart < sub.end) {
            overlapFixes++;
            originalSlotDuration = Math.max(0.05, nextStart - sub.start);
            availableSpeechWindow = originalSlotDuration;
        }
        if (mode === 'hybrid') {
            originalSlotDuration = Math.max(rawSlot, MIN_HYBRID_SLOT_SEC);
            const outputDuration = Math.max(originalSlotDuration, ttsDur + MIN_GAP_SEC);
            let videoStretchFactor = outputDuration / originalSlotDuration;
            if (videoStretchFactor > MAX_VIDEO_STRETCH) {
                videoStretchFactor = MAX_VIDEO_STRETCH;
            }
            if (videoStretchFactor > 1.01)
                stretchedSegments++;
            items.push({
                index: i,
                originalStart: sub.start,
                originalEnd: sub.end,
                originalSlotDuration,
                ttsPath: sub.clipPath,
                ttsDuration: ttsDur,
                outputStart: outputCursor,
                outputDuration,
                videoStretchFactor,
                ttsSpeedFactor: 1,
            });
            outputCursor += outputDuration;
        }
        else {
            let ttsSpeedFactor = 1;
            if (ttsDur > availableSpeechWindow) {
                ttsSpeedFactor = Math.min(MAX_SPEED_UP, ttsDur / availableSpeechWindow);
                spedUpSegments++;
            }
            items.push({
                index: i,
                originalStart: sub.start,
                originalEnd: sub.end,
                originalSlotDuration,
                ttsPath: sub.clipPath,
                ttsDuration: ttsDur,
                outputStart: sub.start,
                outputDuration: availableSpeechWindow,
                videoStretchFactor: 1,
                ttsSpeedFactor,
            });
            outputCursor = Math.max(outputCursor, sub.start + availableSpeechWindow);
        }
        lastOriginalEnd = Math.max(lastOriginalEnd, sub.end);
    }
    return {
        mode,
        items,
        gaps,
        finalGap: undefined,
        totalOutputDuration: outputCursor,
        stats: { stretchedSegments, spedUpSegments, overlapFixes },
    };
}
function attachFinalGap(plan, videoDuration) {
    const lastOriginalEnd = plan.items.length > 0
        ? Math.max(...plan.items.map((item) => item.originalEnd))
        : 0;
    if (videoDuration > lastOriginalEnd + 0.001) {
        const duration = videoDuration - lastOriginalEnd;
        const outputStart = plan.mode === 'hybrid'
            ? plan.totalOutputDuration
            : lastOriginalEnd;
        return {
            ...plan,
            finalGap: { originalStart: lastOriginalEnd, duration, outputStart },
            totalOutputDuration: plan.mode === 'hybrid' ? plan.totalOutputDuration + duration : videoDuration,
        };
    }
    return plan;
}
