import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { resolveAspectRatio } from '../src/video/aspectRatios';
import {
  SCENE_AUDIO_LEAD_IN_SEC,
  buildAlignedMasterWav,
  computeSceneWindows,
  getTotalFrames,
} from '../src/video/timeline';
import type { VideoProject } from '../src/video/types';
import { checkFfmpegAvailability } from './voiceEngine';

const execFileAsync = promisify(execFile);

let cachedBundleServeUrl: string | null = null;
let cachedBundleSrcMtimeMs: number = 0;
let bundlingPromise: Promise<string> | null = null;

function getLatestTreeMtimeMs(dir: string): number {
  let latest = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = getLatestTreeMtimeMs(full);
        if (sub > latest) latest = sub;
      } else {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      }
    }
  } catch {
    // Ignore transient fs errors
  }
  return latest;
}

async function getRemotionBundleUrl(rootDir: string): Promise<string> {
  const srcMtimeMs = getLatestTreeMtimeMs(path.resolve(rootDir, 'src'));
  if (
    cachedBundleServeUrl &&
    fs.existsSync(cachedBundleServeUrl) &&
    srcMtimeMs <= cachedBundleSrcMtimeMs
  ) {
    return cachedBundleServeUrl;
  }
  if (!bundlingPromise) {
    const entryPoint = path.resolve(rootDir, 'src/remotion/index.ts');
    const publicDir = path.resolve(rootDir, 'public');
    const buildStamp = Math.max(srcMtimeMs, Date.now());
    bundlingPromise = bundle({
      entryPoint,
      publicDir,
      onProgress: () => {
        // Bundling progress tracked cleanly by caller
      },
    })
      .then((serveUrl) => {
        cachedBundleServeUrl = serveUrl;
        cachedBundleSrcMtimeMs = buildStamp;
        bundlingPromise = null;
        return serveUrl;
      })
      .catch((err) => {
        bundlingPromise = null;
        throw err;
      });
  }
  return bundlingPromise;
}

function loadSceneWavBytes(
  audioDataUrl: string | undefined,
  publicDir: string
): Uint8Array | undefined {
  if (!audioDataUrl) return undefined;
  if (audioDataUrl.startsWith('data:')) {
    const base64 = audioDataUrl.split(',')[1] || '';
    return base64 ? new Uint8Array(Buffer.from(base64, 'base64')) : undefined;
  }
  if (audioDataUrl.startsWith('/')) {
    const cleanRel = audioDataUrl.replace(/^\/+/, '');
    const candidate = path.resolve(publicDir, cleanRel);
    if (candidate.startsWith(publicDir) && fs.existsSync(candidate)) {
      return new Uint8Array(fs.readFileSync(candidate));
    }
  }
  return undefined;
}

function mixTransitionWhooshesIntoWav(
  wavBytes: Uint8Array,
  boundarySeconds: number[]
): Uint8Array {
  if (wavBytes.length <= 44 || boundarySeconds.length === 0) return wavBytes;

  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const channels = view.getUint16(22, true) || 1;
  const sampleRate = view.getUint32(24, true) || 24000;
  const totalSamplesPerChannel = Math.floor((wavBytes.length - 44) / (2 * channels));

  const whooshDur = 0.28;
  const whooshLen = Math.floor(sampleRate * whooshDur);
  const whooshPcm = new Float32Array(whooshLen);
  let last = 0;
  let seed = 0x9e3779b9;
  for (let i = 0; i < whooshLen; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = (seed / 0xffffffff) * 2 - 1;
    const env = Math.sin((i / whooshLen) * Math.PI);
    last = last * 0.78 + white * 0.22;
    whooshPcm[i] = last * env * 0.09;
  }

  for (const sec of boundarySeconds) {
    const startSample = Math.round(sec * sampleRate);
    for (let i = 0; i < whooshLen; i++) {
      const targetSample = startSample + i;
      if (targetSample < 0 || targetSample >= totalSamplesPerChannel) continue;
      const addVal = Math.round(whooshPcm[i] * 32767);
      for (let c = 0; c < channels; c++) {
        const byteOffset = 44 + (targetSample * channels + c) * 2;
        if (byteOffset + 2 > wavBytes.length) break;
        const cur = view.getInt16(byteOffset, true);
        const mixed = Math.max(-32768, Math.min(32767, cur + addVal));
        view.setInt16(byteOffset, mixed, true);
      }
    }
  }

  return wavBytes;
}

export function mixProjectAudioToWav(
  project: VideoProject,
  fps: number,
  publicDir: string
): Uint8Array {
  const windows = computeSceneWindows(project.scenes, fps);
  const slots = windows.map((w) => ({
    wavBytes: loadSceneWavBytes(w.scene.audioDataUrl, publicDir),
    targetDurationSec: w.durationFrames / fps,
    leadInSec: SCENE_AUDIO_LEAD_IN_SEC,
  }));

  let master = buildAlignedMasterWav(slots);
  if (master.length === 0) {
    const totalSec = windows.length > 0 ? windows[windows.length - 1].endSec : 1;
    const sampleRate = 24000;
    const dataBytes = Math.max(2, Math.round(totalSec * sampleRate) * 2);
    master = new Uint8Array(44 + dataBytes);
    const v = new DataView(master.buffer);
    master.set([0x52, 0x49, 0x46, 0x46], 0);
    v.setUint32(4, 36 + dataBytes, true);
    master.set([0x57, 0x41, 0x56, 0x45], 8);
    master.set([0x66, 0x6d, 0x74, 0x20], 12);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    master.set([0x64, 0x61, 0x74, 0x61], 36);
    v.setUint32(40, dataBytes, true);
  }

  if (project.sfxEnabled) {
    const boundaries = windows.slice(1).map((w) => w.startSec);
    master = mixTransitionWhooshesIntoWav(master, boundaries);
  }

  return master;
}

export async function renderUnifiedRemotionMp4(
  rootDir: string,
  project: VideoProject,
  outMp4Path: string,
  onProgress?: (progress: number, label: string) => void
): Promise<{
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}> {
  const fps = 60;
  const dims = resolveAspectRatio(project.aspectRatio, project.width, project.height);
  const publicDir = path.resolve(rootDir, 'public');
  const totalFrames = getTotalFrames(project.scenes, fps);
  const totalDurationSec = totalFrames / fps;

  const hasFfmpeg = await checkFfmpegAvailability(true);
  if (!hasFfmpeg) {
    throw new Error(
      'FFmpeg was not found on your system PATH. Install FFmpeg locally (macOS: brew install ffmpeg, Windows: winget install Gyan.FFmpeg, Linux: sudo apt install ffmpeg) to export MP4 with US Andrew AAC audio.'
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-remotion-'));

  try {
    onProgress?.(0.03, 'Mixing synchronized US Andrew master WAV + SFX...');
    const masterWav = mixProjectAudioToWav(project, fps, publicDir);
    const wavPath = path.join(tmpDir, 'master.wav');
    fs.writeFileSync(wavPath, masterWav);

    onProgress?.(0.08, 'Preparing unified Remotion bundle & headless renderer...');
    const [serveUrl] = await Promise.all([
      getRemotionBundleUrl(rootDir),
      ensureBrowser(),
    ]);

    const inputProps = {
      project: {
        ...project,
        aspectRatio: dims.aspectRatio,
        width: dims.width,
        height: dims.height,
        fps: 60 as const,
      },
      muted: true,
    };

    const composition = await selectComposition({
      serveUrl,
      id: 'CloudMotionVideo',
      inputProps,
    });

    const rawVideoPath = path.join(tmpDir, 'video-only.mp4');
    onProgress?.(0.14, `Rendering ${dims.width}×${dims.height} 60fps via Remotion...`);

    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      crf: 16,
      pixelFormat: 'yuv420p',
      outputLocation: rawVideoPath,
      inputProps,
      muted: true,
      chromeMode: 'headless-shell',
      onProgress: ({ progress, renderedFrames, encodedFrames }) => {
        const mapped = 0.14 + progress * 0.78;
        const pct = Math.min(99, Math.round(progress * 100));
        onProgress?.(
          mapped,
          `Remotion ${dims.aspectRatio} · ${renderedFrames.toLocaleString()} rendered / ${encodedFrames.toLocaleString()} encoded (${pct}%)`
        );
      },
    });

    onProgress?.(0.94, 'Muxing 192kbps AAC master audio with Remotion video stream...');
    const tmpOutMp4 = path.join(tmpDir, 'final.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      rawVideoPath,
      '-i',
      wavPath,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-shortest',
      tmpOutMp4,
    ]);

    fs.mkdirSync(path.dirname(outMp4Path), { recursive: true });
    fs.copyFileSync(tmpOutMp4, outMp4Path);
    const stat = fs.statSync(outMp4Path);
    onProgress?.(1, `${dims.aspectRatio} 60fps MP4 ready!`);

    return {
      sizeBytes: stat.size,
      durationSec: Number(totalDurationSec.toFixed(2)),
      width: dims.width,
      height: dims.height,
      fps,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
