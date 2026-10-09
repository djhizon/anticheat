# Running with Docker

One container serves the web app and the API on a single port (8080). No Node.js install is needed.

## Prerequisites

- Docker Desktop (or Docker Engine with the Compose plugin), running.
- Internet access for the first build (npm packages, whisper.cpp, the `ggml-base` speech model, and the MediaPipe vision assets). The first build takes a few minutes; the image is about 1.4 GB.

## Start

```bash
docker compose up --build
```

Open http://localhost:8080 (use `localhost`, not a LAN IP: the camera needs a secure context, and `localhost` counts as one).

On first start the entrypoint seeds demo data when the database file does not exist yet. The database lives in the named volume `exam-data` (mounted at `/data`), so it survives restarts. To reset it:

```bash
docker compose down -v
```

## Demo accounts

| Role       | Email                          | Password                         |
| ---------- | ------------------------------ | -------------------------------- |
| Student    | `demo.student@example.test`    | `Demo exam password 2026!`       |
| Instructor | `demo.instructor@example.test` | `Demo instructor password 2026!` |
| Classmates | `classmate1..4@example.test`   | `Demo classmate password 2026!`  |

The seed also publishes the exam "AI-Generated Exam - Pack 8". Override the demo credentials with `DEMO_*` variables (see `.env.example`) before the first start.

## Optional keys (`.env.local`)

Create a `.env.local` next to `docker-compose.yml` (it is optional and never baked into the image). For example:

```
GEMINI_API_KEYS=key1,key2
```

Supabase, Microsoft Graph and other settings from `.env.example` work the same way. Do not set `PORT`, `HOST`, `DATABASE_PATH` or `ALLOWED_ORIGINS` there unless you also change the compose file. If you publish on a different host or port, update `ALLOWED_ORIGINS` and `SITE_URL` in `docker-compose.yml` to match.

## What is included

- Web app, API, SQLite database and demo seed.
- Local speech transcription (whisper.cpp `base` model) and `ffmpeg`.
- Browser-side vision (MediaPipe / OWL-ViT assets are served as static files and run in the browser).

## What does not run in Docker

- The Electron desktop shell (`apps/desktop`): run it on the host against http://localhost:8080.
- The iPhone app (`apps/ios`).
- Server-side OWL-ViT object detection (`ENABLE_BACKEND_VISION`): off by default because it needs a multi-GB Python/PyTorch stack. Optional profile:

  ```bash
  docker compose --profile vision up --build app-vision
  ```

  Stop the default `app` service first (both publish port 8080). Model weights download on first use into the volume.

## Notes

- The container runs as the non-root `node` user in development mode over plain HTTP (`COOKIE_SECURE=false`); it is meant for local evaluation, not internet exposure.
- Health check: `GET /auth/csrf`.
