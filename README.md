# ClipForge cloud render worker

This is the production FFmpeg renderer. Railway starts it automatically, keeps
it healthy, and restarts it after failures. No end user needs Docker, a terminal,
local files, or a manually started worker.

```
Browser or Telegram → Cloud app → job queue → Railway worker → private storage → download or Telegram
```

## Railway production deployment

Create a Railway service whose root directory is `worker`. Railway reads
`railway.toml`, builds the pinned Docker image, checks `/healthz`, and restarts
failed replicas. Configure these private variables in Railway:

| Variable | Value |
| --- | --- |
| `API_BASE_URL` | The published ClipForge app origin, with no trailing slash |
| `WORKER_SECRET` | The same private worker secret stored by the cloud app |
| `WORKER_ID` | A stable service label such as `railway-production` |
| `POLL_INTERVAL_MS` | Optional; defaults to `4000` |
| `AI_DIRECTOR` | `true` in production |

Allocate at least 2 vCPU, 4 GB RAM, and 4 GB ephemeral disk per replica. Keep one
replica until render throughput requires more; queue leases make additional
replicas safe. Deploy from the repository, not a ZIP. The worker drains its
current job on shutdown, uses bounded polling backoff, and exposes no public job
or file data through its health endpoint.

The sections below describe the optional legacy local development path only.

## 1. Install Docker Desktop

Download and install Docker Desktop for Windows, then start it and wait until
the whale icon in the tray says "Docker Desktop is running".

## 2. Add your worker secret

1. Extract this folder somewhere simple, e.g. `C:\clipforge-worker`.
2. Make a copy of `.env.example` and name the copy `.env` (exactly that, no
   `.txt` at the end — turn on "File name extensions" in File Explorer's View
   menu so you can see it).
3. Open `.env` in Notepad. Paste your worker secret after `WORKER_SECRET=`, so
   the line looks like:

   ```
   WORKER_SECRET=your-secret-here
   ```

   The secret is the same value saved in the ClipForge app's secure settings.
   It is deliberately **not** included in this download.
4. Save and close.

`API_BASE_URL` is already filled in and points at your cloud app. Leave it
alone unless the app moves to another address.

## 3. Start the worker

Open PowerShell in this folder (Shift + right-click inside the folder →
"Open PowerShell window here") and run:

```powershell
docker compose up --build
```

Or just double-click `start.bat`.

The first build takes a few minutes because it downloads FFmpeg and fonts.
When you see `waiting for jobs…` the worker is healthy — leave the window open.

Now send a video to your Telegram bot, pick a preset, and the finished MP4
comes back in the chat.

## 4. Stop the worker

Press `Ctrl + C` in the window, or double-click `stop.bat`.

To run it quietly in the background instead:

```powershell
docker compose up -d --build   # start
docker compose logs -f         # watch
docker compose down            # stop
```

## Testing Instagram links

To check a public Reel link without going through Telegram:

```powershell
docker compose run --rm worker npm run test:instagram -- https://www.instagram.com/reel/XXXXXXXXX/
```

It prints URL validation, downloader status, the temporary file path, duration,
resolution and a final success/failure reason. Add `--keep` to leave the file on
disk. Only publicly accessible posts work — no logins or cookies are used.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `WORKER_SECRET is not set` | The `.env` file is missing, misnamed, or the secret line is empty. |
| `claim failed [401]` | The secret does not match the one in the cloud app. |
| `docker: command not found` | Docker Desktop is not installed or not started. |
| Nothing happens after a job is sent | Check the app URL in `.env` matches your live app. |

## Moving it to a server later

Nothing here is machine-specific. The same image runs unchanged on Railway,
Fly.io, Hetzner or any VPS — copy the folder, set the same variables, start it.

## What it does per job

1. Claims one job (lease-protected, so a crash returns the job to the queue).
2. Gets the source: an uploaded file arrives through a short-lived signed link;
   an Instagram Reel link is fetched by the swappable module in
   `src/sources/` (`instagram.js` today; drop in `tiktok.js` / `youtube.js`
   later without touching the renderer). Only publicly accessible posts are
   fetched — nothing bypasses logins or access controls. The downloaded file
   lives in a temp folder and is deleted as soon as the job ends.
3. `ffprobe` for exact metadata — resolution, duration, fps, audio, rotation.
4. Detects stable black/white source padding and removes it conservatively.
5. Builds an adaptive headline/video/branding layout from the render configuration.
6. Logs source aspect, content rectangle, final dimensions, top/bottom padding and crop amount.
7. Renders 1080×1920 H.264 + AAC without stretching.
8. Uploads through a signed link and reports completion.

Delivery to Telegram happens in the cloud, exactly once, guarded in the database.

## Environment

| Variable | Meaning |
| --- | --- |
| `API_BASE_URL` | Cloud app base URL |
| `WORKER_SECRET` | Shared secret; must match the cloud value |
| `WORKER_ID` | Free-text name shown in the dashboard |
| `POLL_INTERVAL_MS` | Idle poll interval, default 4000 |

Curated fonts and an emoji fallback are installed inside the container. Font
choices made under Telegram Settings → Fonts are saved and included with each
new edit. Custom `.ttf`, `.otf`, and `.woff2` files are limited to 5 MB, stored
privately, validated again by the worker, and safely fall back when invalid.

## AI Video Director (v1.3)

Before rendering, the worker samples 3–5 frames and asks the ClipForge cloud for a
JSON editing plan (source mode, safe framing, important regions, headline suggestion).
The AI never renders — FFmpeg does. The provider key lives only in the cloud app and
is never present in this folder.

If the director is disabled, times out, is rate-limited or returns malformed JSON,
the worker silently falls back to the deterministic FFprobe/FFmpeg pipeline.

Controls in `.env`:

```
AI_DIRECTOR=true                 # set false to force the deterministic pipeline
AI_DIRECTOR_FRAMES=4
AI_DIRECTOR_TIMEOUT_MS=45000
AI_DIRECTOR_MIN_CONFIDENCE=0.6
```

## Source modes (v1.4)

Every render logs its decision:

```
layout source_mode=KICK_STORY_RECOMPOSE detected=FULL_FRAME_9_16 source_aspect=0.5625 ...
```

* `FULL_FRAME_9_16` — the clip is already a complete 9:16 composition (chosen in
  the bot as **Original 9:16**). It is scaled straight to 1080×1920, aspect
  preserved, with no inner video box, no headline/footer and no outer background.
  Internal split screens, captions and branding stay untouched.
* `KICK_STORY_RECOMPOSE` — explicit **Kick Story recomposition**, applied to every
  source aspect ratio when selected. The output is 1080×1920 with roughly 16%
  headline band, 68% full-width footage and 16% lower band. The footage always
  touches both edges (x=0 → x=1080); only vertical cropping is ever applied, and
  never through protected regions (creator overlays, KICK UI, captions, faces).
* `REFRAME_SOURCE` / `PADDED_SOURCE` — deterministic classification used only
  when the user did not explicitly choose Kick Story.

### Background styles

Kick Story offers three background styles that change ONLY the pixels around
the footage — foreground geometry, crop, scale and content are identical across
all three (verified by the regression suite):

* `white` — Kick Story (default)
* `black` — cinematic; black text is automatically flipped to white
* `blur` — the source itself, fill-scaled, strongly blurred and darkened

### Framing

* `safe_fit` (default) — keeps the complete source width, crops vertically only
  when needed, and falls back whenever a crop would hit a protected region.
* `smart_crop` — allowed to center-crop vertically within safety bounds.
* `fill` — fills the whole middle band exactly; may crop wide sources.

## Visual regression gate

Before shipping any worker build, run:

```
docker compose run --rm worker npm run test:recompose -- <vertical.mp4> [target.mp4]
```

It renders the problematic vertical clip (White, Black, Blur), an Original 9:16
clip, a horizontal clip and the desired-target clip, then asserts:
recomposition mode is applied, no side margins, ~16% bands, full-width
foreground, zero width crop on Safe Fit, and pixel-identical foregrounds across
background styles. A ZIP may only be packaged when every check passes.
