# ShadowClip Web

A browser-based version of ShadowClip: trim gameplay clips, step through them
frame by frame, and create shareable MP4s — **without installing anything**.
Everything runs client-side; the videos you drop in never leave your machine.

## Running it

It's a static site, so any static file server works:

```
cd web
python3 -m http.server 8000      # or: npx serve .
```

then open <http://localhost:8000>. It also works hosted on GitHub Pages or any
web host (no special headers required — the single-threaded ffmpeg.wasm core is
used deliberately so COOP/COEP isn't needed).

> Opening `index.html` directly from disk (`file://`) won't work because the
> app uses ES modules — serve it over HTTP.

## Features

- **Drag & drop** one or more ShadowPlay recordings (or use *Open videos…*);
  files are read locally via the File API, never uploaded.
- **Frame-by-frame scrubbing, forwards and backwards** (`←`/`→`, hold to
  repeat). The exact frame rate is read from the MP4 sample table, and
  stepping is anchored to the presentation timestamp of the frame actually on
  screen (`requestVideoFrameCallback`), so steps land on real frame
  boundaries in both directions.
- **Fine scrubbing** by dragging on the video (≈1 ms per pixel, hold `Shift`
  for 10 ms per pixel), just like the desktop app. A click without dragging
  toggles play/pause.
- **Segments** with per-segment **speed** (0.25×–4×) and **center zoom**
  (1×/2×/4×), previewed live during playback. Segments are concatenated in
  order when the clip is created — the same model as the desktop app.
  The initial segment covers the last 30% of the clip, matching the desktop
  default for ShadowPlay recordings.
- **Timeline** with a thumbnail filmstrip, draggable segment edges, and a
  playhead.
- **In-browser export** via ffmpeg.wasm using the same filter graph as the
  desktop app (`trim`/`setpts`, `scale`+`crop` zoom, `setpts`/`atempo` speed,
  `concat`, optional `setdar=16/9`):
  - *Re-encode* — frame-accurate cuts, x264 CRF 25 (slow in a browser; that's
    the trade-off for not installing anything).
  - *Stream copy* — near-instant, but cuts at keyframes and (as on desktop)
    only for a single segment with no speed/zoom/16:9 changes.
- **Screenshot** of the current frame (respecting zoom) straight to the
  clipboard, with download fallback.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` (or `,` / `.`) | Step one frame back / forward |
| `Shift+←` / `Shift+→` | Jump 1 second |
| `[` / `]` | Set start / end of the segment under the playhead |
| `Home` / `End` | Jump to clip start / end |
| `M` | Mute |
| `S` | Screenshot |

## Notes & limitations

- The ffmpeg engine (~31 MB) is fetched from a CDN (unpkg) the first time you
  export and cached by the browser afterwards. To self-host it, download
  `@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js`,
  `@ffmpeg/util@0.12.1/dist/umd/index.js`, and
  `@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js` + `ffmpeg-core.wasm`, then set
  `window.SHADOWCLIP_FFMPEG_URLS = { ffmpegJs, utilJs, coreJs, coreWasm }`
  before `js/app.js` loads. (The worker, `vendor/ffmpeg-worker.js`, is already
  served locally by this app.)
- Browser encoding is single-threaded WebAssembly — expect re-encodes to be
  much slower than the desktop app. Stream copy is fast.
- Very large recordings (≳1.5 GB) can exceed the WebAssembly memory limit
  during export.
- HEVC/HDR captures may not *play* in browsers without HEVC support, though
  export can still work since decoding happens in ffmpeg.wasm.
- Frame stepping uses `requestVideoFrameCallback` (all modern browsers);
  without it the app falls back to fps-based stepping.
- For non-MP4 containers (WebM/MKV) the frame rate is estimated from
  playback, which can't see rates above your display's refresh rate — a
  120 fps WebM on a 60 Hz screen steps 2 frames at a time. MP4s (including
  all ShadowPlay recordings) use the exact rate from the file's metadata.
