# Strip — audio & subtitle extractor

A browser-based tool that pulls an audio track and any subtitle tracks out of a
video file. Everything runs client-side with `ffmpeg.wasm` — nothing is
uploaded to a server, which is also why this deploys cleanly on Vercel as a
static site (no backend, no timeouts, no server compute cost).

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Push this folder to a GitHub repo (root of the repo = this folder, i.e.
   `package.json` should sit at the repo root, not nested inside a subfolder).
2. In Vercel: **Add New → Project → Import** that repo.
3. Framework preset: Vercel auto-detects **Vite** — leave build command as
   `vite build` and output directory as `dist`. No environment variables
   needed.
4. Deploy.

No special headers or config are required: the app uses the single-threaded
`ffmpeg.wasm` core loaded from a CDN at runtime, so it does not need
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers.

## How it works

- Drag in a video (`mp4`, `mov`, `mkv`, `avi`, `flv`, `webm`, …).
- `ffmpeg -i` is run once against the file to list its streams (audio, video,
  subtitle) and duration.
- **Audio**: extracted with `-vn` into your chosen format (mp3, wav, ogg,
  flac, aac).
- **Subtitles**: if a text-based subtitle stream is present (`subrip`,
  `mov_text`, `ass`, `webvtt`, …) it's converted to `.srt`. Bitmap subtitle
  formats (e.g. DVD/PGS) are copied out in their native container instead,
  since they can't be converted to text.

## Notes

- Large files can be slow and memory-hungry since decoding happens on the
  visitor's CPU in-browser. That's the tradeoff for not needing a server.
- The original desktop version of this tool (Python + Tkinter,
  `extractor.py`) still lives in `Audio-Extractor-master/` if you'd rather run
  something locally instead of in a browser.
