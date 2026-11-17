import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_TEMPLATES,
  createBlankProject,
  createProjectFromTemplate,
} from './src/video/projectTemplates';
import { clampVoiceSpeedPct } from './src/video/speechPacing';
import type { AspectRatio, MaleVoiceId, VideoProject } from './src/video/types';
import { mountMcpBridge } from './server/mcpBridge';
import { RenderManager } from './server/renderManager';
import {
  checkFfmpegAvailability,
  getGenAIClient,
  synthesizeStudioVoice,
} from './server/voiceEngine';
import { WorkspaceStore } from './server/workspaceStore';

const execFileAsync = promisify(execFile);

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const store = new WorkspaceStore(__dirname);
  const audioDir = path.resolve(__dirname, 'public/audio');
  const rendersDir = path.resolve(__dirname, 'public/renders');
  const backgroundsDir = path.resolve(__dirname, 'public/backgrounds');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(rendersDir, { recursive: true });
  fs.mkdirSync(backgroundsDir, { recursive: true });
  app.use('/audio', express.static(audioDir));
  app.use('/renders', express.static(rendersDir));
  app.use('/backgrounds', express.static(backgroundsDir));

  const renderManager = new RenderManager(__dirname, rendersDir, store);

  // Mount MCP server (/mcp) for OpenCode & external CLI agents
  mountMcpBridge(app, store, renderManager);

  // SSE Live-Sync Stream for browser IDE
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(
      `data: ${JSON.stringify({ type: 'connected', activeProjectId: store.getActiveProjectId() })}\n\n`
    );
    store.addSseClient(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 25000);
    req.on('close', () => clearInterval(keepAlive));
  });

  app.get('/api/health', async (_req, res) => {
    const ffmpegAvailable = await checkFfmpegAvailability();
    res.json({
      ok: true,
      ffmpegAvailable,
      edgeTtsReady: true,
      geminiConfigured: Boolean(getGenAIClient()),
      activeProjectId: store.getActiveProjectId(),
    });
  });

  app.get('/api/external-events', (_req, res) => {
    res.json({ events: store.getExternalEvents() });
  });

  app.get('/api/templates', (_req, res) => {
    res.json({ templates: PROJECT_TEMPLATES });
  });

  // Persistent local video background uploads (served statically for Player & Remotion MP4 export)
  app.post(
    '/api/backgrounds',
    express.raw({ type: ['video/mp4', 'video/webm', 'application/octet-stream'], limit: '80mb' }),
    (req, res) => {
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length < 128) {
        return res.status(400).json({ error: 'Valid MP4 or WebM binary payload is required.' });
      }
      const rawName = String(req.headers['x-file-name'] || 'background.mp4');
      const ext = path.extname(rawName).toLowerCase() === '.webm' ? '.webm' : '.mp4';
      const base =
        path
          .basename(rawName, path.extname(rawName))
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 40) || 'bg';
      const safeFilename = `${base}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}${ext}`;
      const targetPath = path.join(backgroundsDir, safeFilename);
      fs.writeFileSync(targetPath, buf);
      return res.status(201).json({
        url: `/backgrounds/${safeFilename}`,
        fileName: rawName,
      });
    }
  );

  // Workspace Project CRUD
  app.get('/api/projects', (_req, res) => {
    const activeProject = store.getProject();
    res.json({
      activeProjectId: store.getActiveProjectId(),
      activeProject,
      projects: store.listProjects(),
    });
  });

  app.post('/api/projects', (req, res) => {
    const { title, aspectRatio } = req.body as {
      title?: string;
      aspectRatio?: AspectRatio;
    };
    const created = createBlankProject(
      title?.trim() || 'Untitled Studio Video',
      aspectRatio || '16:9'
    );
    const saved = store.saveProject(created, 'ui');
    res.status(201).json({ project: saved, projects: store.listProjects() });
  });

  app.post('/api/projects/from-template', (req, res) => {
    const { templateId, title, aspectRatio } = req.body as {
      templateId?: string;
      title?: string;
      aspectRatio?: AspectRatio;
    };
    const created = createProjectFromTemplate(
      templateId || 'feature-launch',
      title,
      aspectRatio
    );
    const saved = store.saveProject(created, 'ui');
    res.status(201).json({ project: saved, projects: store.listProjects() });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    res.json({ project });
  });

  app.post('/api/projects/:id/activate', (req, res) => {
    const project = store.setActiveProjectId(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    res.json({ project, activeProjectId: project.id });
  });

  app.put('/api/projects/:id', (req, res) => {
    const body = req.body as VideoProject;
    if (!body || !Array.isArray(body.scenes)) {
      return res.status(400).json({ error: 'Valid project payload with scenes[] is required.' });
    }
    const source = req.headers['x-agent-source'] === 'external' ? 'mcp' : 'ui';
    const saved = store.saveProject({ ...body, id: req.params.id }, source);
    if (source === 'mcp') {
      store.recordExternalActivity(
        String(req.headers['user-agent'] || 'REST Client').slice(0, 40),
        'PUT /api/projects/:id',
        saved.id,
        `Updated project "${saved.title}" (${saved.scenes.length} scenes)`
      );
    }
    res.json({ project: saved });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const deleted = store.deleteProject(req.params.id);
    if (!deleted) {
      return res.status(400).json({ error: 'Cannot delete the only project or project not found.' });
    }
    res.json({
      ok: true,
      activeProjectId: store.getActiveProjectId(),
      activeProject: store.getProject(),
      projects: store.listProjects(),
    });
  });

  // Studio Voiceover Synthesis (Local Edge Neural primary + optional Gemini backup)
  app.post('/api/tts', async (req, res) => {
    try {
      const {
        text,
        voiceName = 'Andrew',
        speedPct = 0,
        projectId,
        sceneId,
      } = req.body as {
        text?: string;
        voiceName?: MaleVoiceId | string;
        speedPct?: number;
        projectId?: string;
        sceneId?: string;
      };

      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Narration text is required.' });
      }

      const safeSpeed = clampVoiceSpeedPct(speedPct);
      const result = await synthesizeStudioVoice({
        text,
        voiceId: voiceName,
        speedPct: safeSpeed,
      });

      let audioDataUrl: string;
      if (projectId && sceneId) {
        audioDataUrl = store.saveSceneAudioWav(
          projectId,
          sceneId,
          `${result.voiceName}|${safeSpeed}|${text.trim()}`,
          result.wavBytes
        );
      } else {
        audioDataUrl = `data:audio/wav;base64,${Buffer.from(result.wavBytes).toString('base64')}`;
      }

      return res.json({
        audioDataUrl,
        durationSec: result.durationSec,
        voiceName: result.voiceName,
        model: result.providerUsed,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Speech synthesis failed.';
      const status = raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED') ? 429 : 500;
      return res.status(status).json({ error: raw.slice(0, 320) });
    }
  });

  // Unified Remotion 60fps MP4 Render Pipeline
  app.get('/api/render-status', (req, res) => {
    const pid = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    return res.json(renderManager.getStatus(pid));
  });

  app.post('/api/render-mp4', (req, res) => {
    const bodyProject = (req.body as { project?: VideoProject } | undefined)?.project;
    const targetProject =
      bodyProject && Array.isArray(bodyProject.scenes)
        ? store.saveProject(bodyProject, 'system')
        : store.getProject()!;

    const result = renderManager.startRender(targetProject);
    if (!result.started && result.error) {
      return res.status(400).json({ ...result.status, error: result.error });
    }
    return res.status(202).json({
      started: result.started,
      alreadyRunning: result.alreadyRunning,
      ...result.status,
    });
  });

  app.get('/api/download-project', async (_req, res) => {
    const zipTmp = path.join(os.tmpdir(), `cloudmotion-studio-${Date.now()}.zip`);
    const pyScript = `
import os, sys, zipfile
root_dir = sys.argv[1]
out_zip = sys.argv[2]
exclude_dirs = {'node_modules', 'dist', '.git', '.playwright-cli', 'workspace'}
exclude_rel_prefixes = (
    os.path.join('public', 'renders'),
    os.path.join('public', 'audio'),
    os.path.join('public', 'backgrounds'),
)
with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
    for cur, dirs, files in os.walk(root_dir):
        rel_cur = os.path.relpath(cur, root_dir)
        dirs[:] = [
            d for d in dirs
            if d not in exclude_dirs and not os.path.normpath(os.path.join(rel_cur, d)).lstrip('./').startswith(exclude_rel_prefixes)
        ]
        for fname in files:
            if fname.startswith('.env') and fname != '.env.example':
                continue
            full = os.path.join(cur, fname)
            rel = os.path.relpath(full, root_dir)
            compress = zipfile.ZIP_STORED if fname.endswith(('.mp4', '.wav', '.webm', '.png')) else zipfile.ZIP_DEFLATED
            zf.write(full, arcname=os.path.join('cloudmotion-studio', rel), compress_type=compress)
`;
    try {
      await execFileAsync('python3', ['-c', pyScript, __dirname, zipTmp]);
      res.download(zipTmp, 'cloudmotion-studio-opencode.zip', () => {
        try {
          fs.unlinkSync(zipTmp);
        } catch {
          // Ignore cleanup
        }
      });
    } catch (err) {
      try {
        fs.unlinkSync(zipTmp);
      } catch {
        // Ignore cleanup
      }
      const msg = err instanceof Error ? err.message : 'Project archive failed.';
      res.status(500).json({ error: msg });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CloudMotion Studio IDE server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
