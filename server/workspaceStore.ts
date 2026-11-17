import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Response } from 'express';
import { resolveAspectRatio } from '../src/video/aspectRatios';
import { createBlankProject } from '../src/video/projectTemplates';
import {
  clampVoiceSpeedPct,
  normalizeLocalVoiceId,
} from '../src/video/speechPacing';
import type { AspectRatio, VideoProject, VideoScene } from '../src/video/types';

export interface ExternalAgentEvent {
  id: string;
  timestamp: string;
  client: string;
  tool: string;
  projectId: string;
  summary: string;
}

export class WorkspaceStore {
  private readonly rootDir: string;
  private readonly projectsDir: string;
  private readonly audioRootDir: string;
  private readonly rendersRootDir: string;
  private readonly metaPath: string;
  private activeProjectId: string = 'studio-blank';
  private sseClients = new Set<Response>();
  private externalEvents: ExternalAgentEvent[] = [];

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.projectsDir = path.join(rootDir, 'workspace', 'projects');
    this.audioRootDir = path.join(rootDir, 'public', 'audio');
    this.rendersRootDir = path.join(rootDir, 'public', 'renders');
    this.metaPath = path.join(rootDir, 'workspace', 'state.json');

    fs.mkdirSync(this.projectsDir, { recursive: true });
    fs.mkdirSync(this.audioRootDir, { recursive: true });
    fs.mkdirSync(this.rendersRootDir, { recursive: true });

    this.bootstrap();
  }

  private bootstrap() {
    const files = fs.readdirSync(this.projectsDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) {
      const blank = createBlankProject('Untitled Studio Video', '16:9', 'studio-blank');
      this.saveProject(blank, 'system');
    }
    if (fs.existsSync(this.metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
        if (meta?.activeProjectId && this.hasProject(meta.activeProjectId)) {
          this.activeProjectId = meta.activeProjectId;
          return;
        }
      } catch {
        // Fallback to first available project
      }
    }
    const first = this.listProjects()[0];
    if (first) {
      this.activeProjectId = first.id;
      this.persistMeta();
    }
  }

  private persistMeta() {
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify({ activeProjectId: this.activeProjectId }, null, 2)
    );
  }

  private projectFilePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.projectsDir, `${safe}.json`);
  }

  hasProject(id: string): boolean {
    return fs.existsSync(this.projectFilePath(id));
  }

  getActiveProjectId(): string {
    return this.activeProjectId;
  }

  setActiveProjectId(id: string): VideoProject | null {
    const proj = this.getProject(id);
    if (!proj) return null;
    this.activeProjectId = proj.id;
    this.persistMeta();
    this.broadcast({
      type: 'active_project_changed',
      projectId: proj.id,
      project: proj,
    });
    return proj;
  }

  listProjects(): Array<{
    id: string;
    title: string;
    aspectRatio: AspectRatio;
    sceneCount: number;
    updatedAt: string;
  }> {
    const files = fs.readdirSync(this.projectsDir).filter((f) => f.endsWith('.json'));
    const list: Array<{
      id: string;
      title: string;
      aspectRatio: AspectRatio;
      sceneCount: number;
      updatedAt: string;
    }> = [];

    for (const file of files) {
      try {
        const p = JSON.parse(
          fs.readFileSync(path.join(this.projectsDir, file), 'utf8')
        ) as VideoProject;
        const dims = resolveAspectRatio(p.aspectRatio, p.width, p.height);
        list.push({
          id: p.id,
          title: p.title,
          aspectRatio: dims.aspectRatio,
          sceneCount: Array.isArray(p.scenes) ? p.scenes.length : 0,
          updatedAt: p.updatedAt || new Date().toISOString(),
        });
      } catch {
        // Skip corrupt project JSON
      }
    }
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getProject(id?: string): VideoProject | null {
    const targetId = id || this.activeProjectId;
    const fp = this.projectFilePath(targetId);
    if (!fs.existsSync(fp)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as VideoProject & {
        chatHistory?: unknown;
      };
      const { chatHistory: _droppedChat, ...rest } = raw;
      const dims = resolveAspectRatio(rest.aspectRatio, rest.width, rest.height);
      return {
        ...rest,
        voiceId: normalizeLocalVoiceId(rest.voiceId),
        voiceSpeedPct: clampVoiceSpeedPct(rest.voiceSpeedPct),
        aspectRatio: dims.aspectRatio,
        width: dims.width,
        height: dims.height,
        scenes: Array.isArray(rest.scenes)
          ? rest.scenes.map((s, idx) => ({ ...s, index: idx + 1 }))
          : [],
      };
    } catch {
      return null;
    }
  }

  saveProject(
    project: VideoProject,
    source: 'ui' | 'mcp' | 'voice' | 'system' = 'ui'
  ): VideoProject {
    const { chatHistory: _droppedChat, ...rawWithoutChat } = project as VideoProject & {
      chatHistory?: unknown;
    };
    const dims = resolveAspectRatio(
      rawWithoutChat.aspectRatio,
      rawWithoutChat.width,
      rawWithoutChat.height
    );
    const normalized: VideoProject = {
      ...rawWithoutChat,
      voiceId: normalizeLocalVoiceId(rawWithoutChat.voiceId),
      voiceSpeedPct: clampVoiceSpeedPct(rawWithoutChat.voiceSpeedPct),
      aspectRatio: dims.aspectRatio,
      width: dims.width,
      height: dims.height,
      scenes: (rawWithoutChat.scenes || []).map((s: VideoScene, i: number) => ({
        ...s,
        id: s.id || `scene-${i + 1}-${crypto.randomBytes(2).toString('hex')}`,
        index: i + 1,
        durationSec: Math.max(1.5, Number(s.durationSec) || 8),
      })),
      updatedAt: new Date().toISOString(),
    };

    const fp = this.projectFilePath(normalized.id);
    fs.writeFileSync(fp, JSON.stringify(normalized, null, 2));
    this.activeProjectId = normalized.id;
    this.persistMeta();

    if (source !== 'system') {
      this.broadcast({
        type: 'project_updated',
        source,
        projectId: normalized.id,
        project: normalized,
      });
    }

    return normalized;
  }

  deleteProject(id: string): boolean {
    if (this.listProjects().length <= 1) return false;
    const fp = this.projectFilePath(id);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);

    // Clean orphaned WAV audio cache & rendered MP4 for this project
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    try {
      const projAudioDir = path.join(this.audioRootDir, safeId);
      if (fs.existsSync(projAudioDir)) {
        fs.rmSync(projAudioDir, { recursive: true, force: true });
      }
      const projMp4 = path.join(this.rendersRootDir, `${safeId}-60fps.mp4`);
      if (fs.existsSync(projMp4)) {
        fs.unlinkSync(projMp4);
      }
    } catch {
      // Ignore cleanup errors
    }

    if (this.activeProjectId === id) {
      const next = this.listProjects()[0];
      if (next) {
        this.activeProjectId = next.id;
        this.persistMeta();
      }
    }
    const activeProj = this.getProject();
    if (activeProj) {
      this.broadcast({
        type: 'active_project_changed',
        projectId: activeProj.id,
        project: activeProj,
      });
    }
    return true;
  }

  saveSceneAudioWav(
    projectId: string,
    sceneId: string,
    textHashKey: string,
    wavBytes: Uint8Array
  ): string {
    const safeProj = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeScene = sceneId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const digest = crypto.createHash('sha1').update(textHashKey).digest('hex').slice(0, 10);
    const dir = path.join(this.audioRootDir, safeProj);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${safeScene}-${digest}.wav`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, wavBytes);
    return `/audio/${safeProj}/${filename}`;
  }

  recordExternalActivity(
    client: string,
    tool: string,
    projectId: string,
    summary: string
  ) {
    const ev: ExternalAgentEvent = {
      id: crypto.randomBytes(4).toString('hex'),
      timestamp: new Date().toISOString(),
      client,
      tool,
      projectId,
      summary,
    };
    this.externalEvents = [ev, ...this.externalEvents].slice(0, 30);
    this.broadcast({
      type: 'external_agent_event',
      event: ev,
    });
  }

  broadcastPreviewSeek(
    projectId: string,
    sceneNumber?: number,
    sceneId?: string,
    play: boolean = false
  ) {
    this.broadcast({
      type: 'preview_seek',
      projectId,
      sceneNumber,
      sceneId,
      play,
    });
  }

  getExternalEvents(): ExternalAgentEvent[] {
    return this.externalEvents;
  }

  addSseClient(res: Response) {
    this.sseClients.add(res);
    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  broadcast(payload: Record<string, unknown>) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}
