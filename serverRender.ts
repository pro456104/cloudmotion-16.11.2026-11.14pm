import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  SCENE_AUDIO_LEAD_IN_SEC,
  buildAlignedMasterWav,
  computeSceneWindows,
  getTotalFrames,
} from './src/video/timeline';
import type { VideoProject } from './src/video/types';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadSceneWavBytes(audioDataUrl: string | undefined, publicDir: string): Uint8Array | undefined {
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
  // Deterministic PRNG noise for crisp, reproducible whoosh envelope matching sfxEngine.ts
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
    // Fallback silent 24kHz mono WAV spanning total video duration
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

export async function renderProjectToMp4OnServer(
  project: VideoProject,
  outMp4Path: string,
  onProgress?: (progress: number, label: string) => void
): Promise<{ sizeBytes: number; durationSec: number; width: number; height: number; fps: number }> {
  const width = 1920;
  const height = 1080;
  const fps = 60;

  const publicDir = path.resolve(__dirname, 'public');
  const fontsDir = path.join(publicDir, 'fonts');
  const windows = computeSceneWindows(project.scenes, fps);
  const totalFrames = getTotalFrames(project.scenes, fps);
  const totalDurationSec = totalFrames / fps;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-1080p60-'));

  try {
    onProgress?.(0.02, 'Mixing 11-scene US-Andrew master WAV + SFX...');
    const masterWav = mixProjectAudioToWav(project, fps, publicDir);
    const wavPath = path.join(tmpDir, 'master.wav');
    fs.writeFileSync(wavPath, masterWav);

    // Partition windows along scene boundaries into up to 4 balanced parallel worker ranges
    const targetWorkers = Math.min(4, Math.max(1, windows.length));
    const chunks: Array<{ startFrame: number; endFrame: number }> = [];
    const approxFramesPerWorker = Math.ceil(totalFrames / targetWorkers);

    let chunkStart = 0;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const isLastScene = i === windows.length - 1;
      const reachedTarget = w.endFrame - chunkStart >= approxFramesPerWorker;
      const remainingChunks = targetWorkers - chunks.length;
      const remainingScenes = windows.length - 1 - i;

      if (isLastScene || (reachedTarget && remainingScenes >= remainingChunks - 1 && chunks.length < targetWorkers - 1)) {
        chunks.push({ startFrame: chunkStart, endFrame: w.endFrame });
        chunkStart = w.endFrame;
      }
    }
    if (chunkStart < totalFrames && chunks.length > 0) {
      chunks[chunks.length - 1].endFrame = totalFrames;
    }

    const tsxBin = path.resolve(__dirname, 'node_modules/.bin/tsx');
    const workerScript = path.resolve(__dirname, 'serverRenderWorker.ts');
    const progressByChunk = new Array<number>(chunks.length).fill(0);
    const segmentPaths: string[] = [];

    const runChunkWorker = (idx: number, range: { startFrame: number; endFrame: number }) =>
      new Promise<void>((resolve, reject) => {
        const segPath = path.join(tmpDir, `seg-${idx}.mp4`);
        const cfgPath = path.join(tmpDir, `job-${idx}.json`);
        segmentPaths[idx] = segPath;

        fs.writeFileSync(
          cfgPath,
          JSON.stringify({
            project,
            startFrame: range.startFrame,
            endFrame: range.endFrame,
            outPath: segPath,
            width,
            height,
            fps,
            fontsDir,
          })
        );

        const child = spawn(tsxBin, [workerScript, cfgPath], {
          cwd: __dirname,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderrText = '';
        let stdoutBuf = '';
        child.stdout.on('data', (d: Buffer) => {
          stdoutBuf += d.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() || '';
          for (const line of lines) {
            const match = /^PROGRESS\s+(\d+)/.exec(line.trim());
            if (match) {
              progressByChunk[idx] = Number(match[1]) || 0;
              const doneTotal = progressByChunk.reduce((a, b) => a + b, 0);
              const pct = 0.04 + (doneTotal / Math.max(1, totalFrames)) * 0.90;
              const pctDisplay = Math.min(99, Math.round((doneTotal / Math.max(1, totalFrames)) * 100));
              onProgress?.(
                pct,
                `Rendering 1080p 60fps · ${doneTotal.toLocaleString()} / ${totalFrames.toLocaleString()} frames (${pctDisplay}%)`
              );
            }
          }
        });

        child.stderr.on('data', (d: Buffer) => {
          stderrText += d.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Render worker ${idx} failed (${code}): ${stderrText.trim()}`));
        });
      });

    onProgress?.(0.04, `Rendering 1080p 60fps across ${chunks.length} parallel studio encoders...`);
    await Promise.all(chunks.map((range, idx) => runChunkWorker(idx, range)));

    onProgress?.(0.95, 'Concatenating 60fps streams & encoding 192kbps AAC master audio...');
    const concatListPath = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(
      concatListPath,
      segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    );

    const tmpOutMp4 = path.join(tmpDir, 'final-1080p60.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
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
    onProgress?.(1, '1080p 60fps MP4 ready & saved inside project!');

    return {
      sizeBytes: stat.size,
      durationSec: Number(totalDurationSec.toFixed(2)),
      width,
      height,
      fps,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures
    }
  }
}
