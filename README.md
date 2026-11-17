# CloudMotion Studio

A Remotion-powered studio for building developer explainer videos, with a Cloud X Berry
motion-design grammar and a studio American English male voiceover.

## Features

- **Script studio** — generate and edit a scene-by-scene script with Gemini.
- **Style analysis** — extract a visual direction and apply it to the composition.
- **Stage view** — preview the animated timeline in the browser via `@remotion/player`.
- **Voiceover** — Gemini TTS narration with pacing, audio cleanup, and scene-synced playback.
- **MP4 export** — render a 1920x1080 60fps master with progress polling.
- **Project export** — download the project as JSON for reuse.

## Tech stack

React 19, TypeScript, Vite, Remotion, Tailwind CSS 4, Express, Google GenAI.

## Getting started

```bash
npm install
cp .env.example .env   # then set GEMINI_API_KEY
npm run dev
```

The dev server starts the Express API and Vite middleware. Open the URL printed in the
terminal (defaults to `http://localhost:3000`).

### Environment variables

| Variable         | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `GEMINI_API_KEY` | Required for script generation and TTS.            |
| `APP_URL`        | Public URL of the app, used for self-referential links. |

### Scripts

| Command         | Description                          |
| --------------- | ------------------------------------ |
| `npm run dev`   | Start the server with Vite middleware |
| `npm run build` | Build the client into `dist/`        |
| `npm start`     | Run the server in production         |
| `npm run lint`  | Type-check with `tsc --noEmit`       |

## Media assets

Rendered videos are **not** committed to this repository. Output is written to
`public/renders/` at runtime, and the server creates that directory on startup.
Narration files in `public/audio/` are part of the demo project and are tracked.
