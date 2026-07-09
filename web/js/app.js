// ShadowClip Web — browser-based gameplay clip editor.
//
// Everything runs client-side: files are opened via drag & drop or the file
// picker and never uploaded. Playback uses the HTML5 video element; frame
// stepping combines the exact fps from the MP4 sample table (mp4.js) with
// requestVideoFrameCallback so steps land on real frame boundaries in both
// directions. Export runs ffmpeg.wasm (exporter.js).

import { parseMp4Info } from './mp4.js';
import { buildExportArgs, copyModeBlockers, outputDuration, exportClip, cancelExport } from './exporter.js';

const $ = id => document.getElementById(id);

const video = $('video');
const videoWrap = $('videoWrap');
const dropOverlay = $('dropOverlay');
const emptyHint = $('emptyHint');
const playbackWarning = $('playbackWarning');
const fileListEl = $('fileList');
const filmstrip = $('filmstrip');
const timelineEl = $('timeline');
const segLayer = $('segLayer');
const playheadEl = $('playhead');
const segRowsEl = $('segRows');
const timeText = $('timeText');
const frameText = $('frameText');
const mediaInfoText = $('mediaInfo');
const toastEl = $('toast');

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];
const ZOOM_PRESETS = [1, 2, 4];
const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 75, 90, 100, 120, 144, 165, 240];
const FALLBACK_FPS = 60;

const state = {
    files: [],            // {id, file, url, info, segments, error}
    current: null,        // entry from files
    segments: [],         // segments of the current file
    duration: 0,
    fps: null,
    fpsSource: null,      // 'metadata' | 'estimated'
    lastMediaTime: null,  // presentation time of the frame on screen (rVFC)
    stepTarget: null,     // absolute time of an in-flight frame step
    previewSegment: null, // segment being previewed (auto-pause at its end)
    pendingSeek: null,    // latest scrub target while a seek is in flight
    exporting: false,
    fpsSamples: [],
    settings: loadSettings(),
};
let nextId = 1;
let filmstripToken = null;
let lastResultUrl = null;

// Debug/test hook.
window.__shadowclip = { state, video, stepFrame, segmentAt, requestSeek, renderSegRows, makeSegment };

// ---------------------------------------------------------------- settings

function loadSettings() {
    const defaults = { volume: 1, muted: false, encoder: 're-encode', forceWideScreen: false };
    try {
        return Object.assign(defaults, JSON.parse(localStorage.getItem('shadowclip.settings') || '{}'));
    } catch {
        return defaults;
    }
}

function saveSettings() {
    try {
        localStorage.setItem('shadowclip.settings', JSON.stringify(state.settings));
    } catch {
        // storage unavailable (private mode) — settings just won't persist
    }
}

// ------------------------------------------------------------------- utils

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function frameDur() {
    return 1 / (state.fps || FALLBACK_FPS);
}

function fmtTime(t) {
    if (!Number.isFinite(t)) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => (toastEl.className = ''), 4000);
}

function safeFileName(name) {
    // Leading dashes must go too — the name becomes an ffmpeg CLI argument.
    return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^[-_]+|_+$/g, '') || 'clip';
}

function fileStem(name) {
    return name.replace(/\.[^.]+$/, '');
}

// ------------------------------------------------------------ file loading

function addFiles(list) {
    const added = [];
    for (const file of list) {
        const looksVideo = /^video\//.test(file.type) || /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(file.name);
        if (!looksVideo) continue;
        const entry = { id: nextId++, file, url: URL.createObjectURL(file), info: null, segments: null, error: null };
        state.files.push(entry);
        added.push(entry);
        parseMp4Info(file).then(info => {
            entry.info = info;
            if (entry === state.current) {
                applyMediaInfo();
                applyParsedDurationFallback();
            }
            renderFileList();
        });
    }
    if (!added.length) {
        toast('No video files found in the drop', true);
        return;
    }
    renderFileList();
    if (!state.current) selectFile(added[0]);
}

function selectFile(entry) {
    if (state.current === entry) return;
    if (state.current) state.current.segments = state.segments; // stash edits
    state.current = entry;
    state.duration = 0;
    state.fps = null;
    state.fpsSource = null;
    state.fpsSamples = [];
    state.lastMediaTime = null;
    state.stepTarget = null;
    state.pendingSeek = null;
    state.previewSegment = null;
    state.segments = entry.segments || [];
    entry.error = null;
    playbackWarning.hidden = true;
    emptyHint.hidden = true;
    video.src = entry.url;
    video.load();
    $('outName').value = safeFileName(fileStem(entry.file.name)) + '_clip';
    applyMediaInfo();
    renderFileList();
    renderSegRows();
    syncSegmentUI();
}

function removeFile(entry) {
    const idx = state.files.indexOf(entry);
    if (idx === -1) return;
    state.files.splice(idx, 1);
    URL.revokeObjectURL(entry.url);
    if (state.current === entry) {
        if (filmstripToken) filmstripToken.cancelled = true;
        state.current = null;
        state.segments = [];
        state.duration = 0;
        video.removeAttribute('src');
        video.load();
        if (state.files.length) {
            selectFile(state.files[Math.min(idx, state.files.length - 1)]);
        } else {
            emptyHint.hidden = false;
            applyMediaInfo();
            renderSegRows();
            syncSegmentUI();
            drawFilmstripPlaceholder();
        }
    }
    renderFileList();
}

function renderFileList() {
    fileListEl.textContent = '';
    for (const entry of state.files) {
        const li = document.createElement('li');
        li.className = entry === state.current ? 'active' : '';
        const name = document.createElement('span');
        name.className = 'fname';
        name.textContent = entry.file.name;
        name.title = entry.file.name;
        const meta = document.createElement('span');
        meta.className = 'fmeta';
        const mb = (entry.file.size / 1048576).toFixed(1) + ' MB';
        const fps = entry.info?.fps ? ` • ${roundFps(entry.info.fps)} fps` : '';
        meta.textContent = mb + fps;
        const remove = document.createElement('button');
        remove.className = 'fremove';
        remove.textContent = '✕';
        remove.title = 'Remove from list';
        remove.addEventListener('click', e => {
            e.stopPropagation();
            removeFile(entry);
        });
        li.append(name, meta, remove);
        li.addEventListener('click', () => selectFile(entry));
        fileListEl.appendChild(li);
    }
    $('fileCount').textContent = state.files.length ? `(${state.files.length})` : '';
}

function roundFps(fps) {
    return Math.abs(fps - Math.round(fps)) < 0.002 ? String(Math.round(fps)) : fps.toFixed(3);
}

function applyMediaInfo() {
    const entry = state.current;
    if (!entry) {
        mediaInfoText.textContent = '';
        return;
    }
    if (entry.info?.fps) {
        state.fps = entry.info.fps;
        state.fpsSource = 'metadata';
    }
    const parts = [];
    if (video.videoWidth) parts.push(`${video.videoWidth}×${video.videoHeight}`);
    if (state.fps)
        parts.push(`${roundFps(state.fps)} fps${state.fpsSource === 'estimated' ? ' (estimated)' : ''}`);
    if (entry.info?.frameCount) parts.push(`${entry.info.frameCount} frames`);
    mediaInfoText.textContent = parts.join(' • ');
}

// -------------------------------------------------------------- player core

video.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(video.duration)) {
        // MediaRecorder-produced WebMs report Infinity until the browser is
        // forced to scan the file; seeking far past the end resolves it.
        const entry = state.current;
        const onDur = () => {
            if (!Number.isFinite(video.duration)) return;
            video.removeEventListener('durationchange', onDur);
            if (state.current !== entry) return;
            video.currentTime = 0;
            initFromMetadata();
        };
        video.addEventListener('durationchange', onDur);
        video.currentTime = 1e10;
        return;
    }
    initFromMetadata();
});

function initFromMetadata() {
    state.duration = video.duration;
    if (!state.segments.length) {
        // Desktop default: ShadowPlay's interesting bit is at the end, so the
        // initial segment covers the last 30% of the clip.
        state.segments = [makeSegment(state.duration * 0.7, state.duration)];
    } else {
        for (const s of state.segments) {
            s.start = clamp(s.start, 0, state.duration);
            s.end = clamp(s.end, s.start, state.duration);
        }
    }
    if (state.current) state.current.segments = state.segments;
    applyMediaInfo();
    renderSegRows();
    syncSegmentUI();
    updateTimeUI();
    buildFilmstrip();
}

video.addEventListener('error', () => {
    if (!state.current) return;
    state.current.error = 'playback';
    playbackWarning.hidden = false;
    applyParsedDurationFallback();
});

// The browser can't decode the source, but if the MP4 parser got a duration
// the segments and export still work (decoding happens in ffmpeg.wasm) —
// there's just no preview. Runs from both the video error handler and the
// async parse completion, whichever comes second.
function applyParsedDurationFallback() {
    const entry = state.current;
    if (!entry || entry.error !== 'playback' || state.duration) return;
    const dur = entry.info?.videoDuration;
    if (!dur || !Number.isFinite(dur)) return;
    state.duration = dur;
    if (!state.segments.length) state.segments = [makeSegment(dur * 0.7, dur)];
    entry.segments = state.segments;
    applyMediaInfo();
    renderSegRows();
    syncSegmentUI();
    updateTimeUI();
}

video.addEventListener('play', () => syncPlayButton());
// Swapping src while playing pauses without a 'pause' event.
video.addEventListener('emptied', () => syncPlayButton());
video.addEventListener('pause', () => {
    state.previewSegment = null;
    syncPlayButton();
});
video.addEventListener('seeked', () => {
    if (state.pendingSeek !== null) {
        const target = state.pendingSeek;
        state.pendingSeek = null;
        if (Math.abs(target - video.currentTime) > frameDur() / 2) {
            video.currentTime = target;
            return;
        }
    }
    updateTimeUI();
});

function syncPlayButton() {
    $('btnPlay').textContent = video.paused ? '▶' : '⏸';
    $('btnPlay').title = video.paused ? 'Play (Space)' : 'Pause (Space)';
}

function togglePlay() {
    if (!state.current) return;
    if (video.paused) {
        state.stepTarget = null;
        video.play().catch(() => {});
    } else {
        video.pause();
    }
}

// Latest presented frame drives the UI: mediaTime is the exact presentation
// timestamp of the frame on screen, which is what frame stepping chains from.
function onVideoFrame(_now, meta) {
    if (state.fpsSource !== 'metadata') estimateFps(meta);
    if (!video.seeking) state.stepTarget = null;
    state.lastMediaTime = meta.mediaTime;
    updateTimeUI(meta.mediaTime);
    video.requestVideoFrameCallback(onVideoFrame);
}
if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);

// Fps estimation fallback for files the MP4 parser can't read (e.g. webm):
// trimmed mean of mediaTime deltas between presented frames during 1x
// playback (webm timestamps are millisecond-quantized, so a plain median
// lands on 1/0.017 = 58.8 for 60 fps sources), snapped to the nearest
// common rate. Seeks reset sampling so scrub jumps never pollute it.
let prevSampleTime = null;
video.addEventListener('seeking', () => (prevSampleTime = null));
function estimateFps(meta) {
    if (video.paused || video.seeking || video.playbackRate !== 1) {
        prevSampleTime = null;
        return;
    }
    if (prevSampleTime !== null) {
        const delta = meta.mediaTime - prevSampleTime;
        if (delta > 0.001 && delta < 0.5) {
            state.fpsSamples.push(delta);
            if (state.fpsSamples.length > 120) state.fpsSamples.shift();
        }
    }
    prevSampleTime = meta.mediaTime;
    if (state.fpsSamples.length >= 20) {
        const sorted = [...state.fpsSamples].sort((a, b) => a - b);
        const trim = Math.floor(sorted.length / 5);
        const kept = sorted.slice(trim, sorted.length - trim);
        const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
        let fps = 1 / mean;
        let best = null;
        let bestErr = Infinity;
        for (const rate of COMMON_RATES) {
            const err = Math.abs(fps - rate) / rate;
            if (err < 0.025 && err < bestErr) {
                best = rate;
                bestErr = err;
            }
        }
        if (best !== null) fps = best;
        state.fps = fps;
        state.fpsSource = 'estimated';
        applyMediaInfo();
    }
}

// Frame stepping. The frame on screen occupies [mediaTime, mediaTime + d).
// Seeking to the *middle* of the neighbouring frame's interval reliably
// lands on that frame in every browser, and chaining pending steps off
// stepTarget keeps rapid key-repeat accurate even while seeks are in flight.
function stepFrame(dir) {
    if (!state.current || !state.duration) return;
    if (!video.paused) video.pause();
    state.previewSegment = null;
    const d = frameDur();
    let base;
    if (state.stepTarget !== null) base = state.stepTarget;
    else if (state.pendingSeek !== null) base = state.pendingSeek;
    // While a scrub seek is in flight, lastMediaTime still describes the old
    // frame — chain from the seek target (currentTime) instead.
    else if (video.seeking) base = video.currentTime;
    else if (state.lastMediaTime !== null && Math.abs(state.lastMediaTime - video.currentTime) < 1)
        base = state.lastMediaTime + d / 2;
    else base = video.currentTime;
    const target = clamp(base + dir * d, 0, Math.max(0, state.duration - d / 4));
    state.stepTarget = target;
    state.pendingSeek = null;
    video.currentTime = target;
    updateTimeUI();
}

// Scrub-style seek: absorbs bursts of requests by only issuing a new seek
// once the previous one lands (see the 'seeked' handler).
function requestSeek(t) {
    if (!state.duration) return;
    state.stepTarget = null;
    state.previewSegment = null;
    const target = clamp(t, 0, state.duration);
    if (!Number.isFinite(target)) return;
    if (video.seeking) {
        state.pendingSeek = target;
    } else {
        state.pendingSeek = null;
        video.currentTime = target;
    }
    updateTimeUI(target);
}

function segmentAt(t) {
    return state.segments.find(s => t >= s.start && t < s.end) || null;
}

function currentFrameIndex(t) {
    return Math.max(0, Math.round(t / frameDur()));
}

// Single place that refreshes playhead, readouts, zoom preview, per-segment
// playback speed, and the segment-preview auto-pause.
function updateTimeUI(mediaTime) {
    const t = mediaTime !== undefined ? mediaTime : video.currentTime;
    timeText.textContent = `${fmtTime(t)} / ${fmtTime(state.duration)}`;
    const total = state.current?.info?.frameCount;
    frameText.textContent = state.fps
        ? `frame ${currentFrameIndex(t)}${total ? ' / ' + total : ''}`
        : '';
    playheadEl.style.left = state.duration ? (t / state.duration) * 100 + '%' : '0%';

    const seg = state.previewSegment || segmentAt(t);
    const zoom = seg ? seg.zoom : 1;
    video.style.transform = zoom > 1 ? `scale(${zoom})` : '';

    if (!video.paused) {
        const wantRate = state.previewSegment ? state.previewSegment.speed : (seg ? seg.speed : 1);
        if (video.playbackRate !== wantRate) video.playbackRate = wantRate;
        if (state.previewSegment && t >= state.previewSegment.end) video.pause();
    }

    for (const el of segLayer.children) {
        const s = state.segments[Number(el.dataset.index)];
        el.classList.toggle('current', !!s && t >= s.start && t < s.end);
    }
}

// Smooth playhead while playing (rVFC only fires on new frames, and not at
// all in browsers without it).
(function rafLoop() {
    if (!video.paused && !video.ended) updateTimeUI();
    requestAnimationFrame(rafLoop);
})();

// Click video = play/pause; drag = fine scrub (desktop: 1 px ≈ 1 ms, shift
// for 10 ms/px).
let vidDrag = null;
video.addEventListener('pointerdown', e => {
    if (!state.current || e.button !== 0) return;
    vidDrag = { startX: e.clientX, lastX: e.clientX, moved: false, wasPlaying: !video.paused };
    video.setPointerCapture(e.pointerId);
});
video.addEventListener('pointermove', e => {
    if (!vidDrag) return;
    const dx = e.clientX - vidDrag.lastX;
    if (Math.abs(e.clientX - vidDrag.startX) > 3 && !vidDrag.moved) {
        vidDrag.moved = true;
        if (vidDrag.wasPlaying) video.pause();
    }
    if (vidDrag.moved && dx !== 0) {
        vidDrag.lastX = e.clientX;
        const scale = e.shiftKey ? 0.01 : 0.001;
        requestSeek((state.pendingSeek ?? video.currentTime) + dx * scale);
    }
});
video.addEventListener('pointerup', e => {
    if (!vidDrag) return;
    const { moved, wasPlaying } = vidDrag;
    vidDrag = null;
    if (!moved) togglePlay();
    else if (wasPlaying) video.play().catch(() => {});
});
video.addEventListener('pointercancel', () => {
    if (vidDrag?.moved && vidDrag.wasPlaying) video.play().catch(() => {});
    vidDrag = null;
});

// ----------------------------------------------------------------- segments

function makeSegment(start, end) {
    return { id: nextId++, start, end, speed: 1, zoom: 1 };
}

function minSegLen() {
    return Math.max(frameDur(), 0.001);
}

// Desktop-style add: split the segment under the playhead, otherwise start a
// fresh segment at the playhead.
function addSegment() {
    if (!state.duration) return;
    const t = video.currentTime;
    const seg = segmentAt(t);
    if (seg && t - seg.start >= minSegLen() && seg.end - t >= minSegLen()) {
        const tail = makeSegment(t, seg.end);
        tail.speed = seg.speed;
        tail.zoom = seg.zoom;
        seg.end = t;
        state.segments.splice(state.segments.indexOf(seg) + 1, 0, tail);
    } else {
        const end = Math.min(t + Math.max(5, state.duration * 0.05), state.duration);
        if (end - t < minSegLen()) {
            toast('Playhead is at the very end — nowhere to add a segment', true);
            return;
        }
        state.segments.push(makeSegment(t, end));
    }
    renderSegRows();
    syncSegmentUI();
}

function removeSegment(seg) {
    if (state.segments.length <= 1) return;
    state.segments.splice(state.segments.indexOf(seg), 1);
    renderSegRows();
    syncSegmentUI();
}

function setSegEdge(seg, side, t, seekPreview = true) {
    if (side === 'start') seg.start = clamp(t, 0, seg.end - minSegLen());
    else seg.end = clamp(t, seg.start + minSegLen(), state.duration);
    if (seekPreview) requestSeek(side === 'start' ? seg.start : seg.end);
    syncSegmentUI();
}

function renderSegRows() {
    segRowsEl.textContent = '';
    segLayer.textContent = '';
    state.segments.forEach((seg, i) => {
        // Timeline block with drag handles.
        const block = document.createElement('div');
        block.className = 'seg-block';
        block.dataset.index = i;
        const label = document.createElement('span');
        label.className = 'seg-label';
        block.appendChild(label);
        for (const side of ['start', 'end']) {
            const handle = document.createElement('div');
            handle.className = `seg-handle ${side}`;
            handle.title = `Drag to set segment ${i + 1} ${side}`;
            handle.addEventListener('pointerdown', e => beginHandleDrag(e, seg, side));
            block.appendChild(handle);
        }
        segLayer.appendChild(block);

        // Editor row.
        const row = document.createElement('div');
        row.className = 'seg-row';
        row.dataset.index = i;

        const title = document.createElement('span');
        title.className = 'seg-title';
        title.textContent = String(i + 1);

        const startInput = numInput(() => seg.start, v => setSegEdge(seg, 'start', v));
        const endInput = numInput(() => seg.end, v => setSegEdge(seg, 'end', v));
        const markIn = smallBtn('⇤', 'Set start to playhead ( [ )', () => setSegEdge(seg, 'start', video.currentTime, false));
        const markOut = smallBtn('⇥', 'Set end to playhead ( ] )', () => setSegEdge(seg, 'end', video.currentTime, false));

        const speedSel = presetSelect(SPEED_PRESETS, seg.speed, v => {
            seg.speed = v;
            syncSegmentUI();
        }, v => v + '×');
        const zoomSel = presetSelect(ZOOM_PRESETS, seg.zoom, v => {
            seg.zoom = v;
            syncSegmentUI();
        }, v => v + '× zoom');

        const preview = smallBtn('▶', 'Preview this segment', () => previewSegment(seg));
        const del = smallBtn('✕', 'Delete segment', () => removeSegment(seg));
        del.disabled = state.segments.length <= 1;

        row.append(title, markIn, startInput, document.createTextNode('→'), endInput, markOut, speedSel, zoomSel, preview, del);
        segRowsEl.appendChild(row);
    });
    syncSegmentUI();
}

function numInput(get, set) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.001';
    input.min = '0';
    input.value = get().toFixed(3);
    input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) set(v);
        input.value = get().toFixed(3);
    });
    input._sync = () => {
        if (document.activeElement !== input) input.value = get().toFixed(3);
    };
    return input;
}

function smallBtn(text, title, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

function presetSelect(presets, value, set, labelFor) {
    const sel = document.createElement('select');
    for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = String(p);
        opt.textContent = labelFor(p);
        if (p === value) opt.selected = true;
        sel.appendChild(opt);
    }
    sel.addEventListener('change', () => set(parseFloat(sel.value)));
    return sel;
}

// Refresh positions/labels without rebuilding the DOM (keeps focus + drags).
function syncSegmentUI() {
    const dur = state.duration || 1;
    state.segments.forEach((seg, i) => {
        const block = segLayer.children[i];
        if (block) {
            block.style.left = (seg.start / dur) * 100 + '%';
            block.style.width = (Math.max(seg.end - seg.start, 0) / dur) * 100 + '%';
            const bits = [String(i + 1)];
            if (seg.speed !== 1) bits.push(seg.speed + '×');
            if (seg.zoom !== 1) bits.push(seg.zoom + '×🔍');
            block.querySelector('.seg-label').textContent = bits.join(' ');
        }
        const row = segRowsEl.children[i];
        if (row) for (const input of row.querySelectorAll('input')) input._sync();
    });
    updateExportPanel();
}

function previewSegment(seg) {
    if (!state.duration) return;
    state.stepTarget = null;
    state.pendingSeek = null;
    video.currentTime = seg.start;
    state.previewSegment = seg;
    video.playbackRate = seg.speed;
    video.play().catch(() => {});
}

// ----------------------------------------------------------------- timeline

function beginHandleDrag(e, seg, side) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const handle = e.target;
    handle.setPointerCapture(e.pointerId);
    const move = ev => setSegEdge(seg, side, xToTime(ev.clientX));
    const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    setSegEdge(seg, side, xToTime(e.clientX));
}

function xToTime(clientX) {
    const rect = timelineEl.getBoundingClientRect();
    return clamp(((clientX - rect.left) / rect.width) * state.duration, 0, state.duration);
}

let tlDrag = false;
timelineEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !state.duration) return;
    if (e.target.classList.contains('seg-handle')) return;
    tlDrag = true;
    timelineEl.setPointerCapture(e.pointerId);
    requestSeek(xToTime(e.clientX));
});
timelineEl.addEventListener('pointermove', e => {
    if (tlDrag) requestSeek(xToTime(e.clientX));
});
timelineEl.addEventListener('pointerup', () => (tlDrag = false));
timelineEl.addEventListener('pointercancel', () => (tlDrag = false));

// ---------------------------------------------------------------- filmstrip

function drawFilmstripPlaceholder() {
    const ctx = filmstrip.getContext('2d');
    ctx.fillStyle = '#14161c';
    ctx.fillRect(0, 0, filmstrip.width, filmstrip.height);
}

async function buildFilmstrip() {
    if (!state.current || !state.duration) return;
    if (filmstripToken) filmstripToken.cancelled = true;
    const token = { cancelled: false };
    filmstripToken = token;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = timelineEl.clientWidth || 800;
    const cssHeight = timelineEl.clientHeight || 56;
    filmstrip.width = Math.round(cssWidth * dpr);
    filmstrip.height = Math.round(cssHeight * dpr);
    drawFilmstripPlaceholder();

    const thumb = document.createElement('video');
    thumb.muted = true;
    thumb.preload = 'auto';
    thumb.src = state.current.url;
    try {
        try {
            await eventOnce(thumb, 'loadedmetadata', 8000);
        } catch {
            return;
        }
        if (token.cancelled || !thumb.videoWidth) return;

        const h = filmstrip.height;
        const w = Math.max(24, Math.round((thumb.videoWidth / thumb.videoHeight) * h));
        const count = Math.ceil(filmstrip.width / w);
        const ctx = filmstrip.getContext('2d');
        for (let i = 0; i < count; i++) {
            if (token.cancelled) return;
            thumb.currentTime = clamp(((i + 0.5) / count) * state.duration, 0, state.duration);
            try {
                await eventOnce(thumb, 'seeked', 4000);
            } catch {
                break;
            }
            if (token.cancelled) return;
            ctx.drawImage(thumb, i * w, 0, w, h);
        }
    } finally {
        // Every exit path must release the media pipeline — detached video
        // elements with a live src can pin decoders until GC gets around
        // to them.
        thumb.removeAttribute('src');
        thumb.load();
    }
}

function eventOnce(el, name, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            el.removeEventListener(name, onEvent);
            reject(new Error('timeout'));
        }, timeoutMs);
        const onEvent = () => {
            clearTimeout(timer);
            resolve();
        };
        el.addEventListener(name, onEvent, { once: true });
    });
}

let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        buildFilmstrip();
        syncSegmentUI();
    }, 300);
});

// --------------------------------------------------------------- screenshot

async function takeScreenshot() {
    if (!state.current || !video.videoWidth) return;
    const seg = segmentAt(video.currentTime);
    const zoom = seg ? seg.zoom : 1;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    const sw = video.videoWidth / zoom;
    const sh = video.videoHeight / zoom;
    ctx.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    // clipboard.write must be called synchronously within the user gesture
    // (Safari invalidates activation across the toBlob await), so hand the
    // ClipboardItem a promise instead of a resolved blob.
    const blobPromise = new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
    try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        toast('Screenshot copied to clipboard');
    } catch {
        const blob = await blobPromise.catch(() => null);
        if (!blob) {
            toast('Screenshot failed', true);
            return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFileName(fileStem(state.current.file.name))}_frame${currentFrameIndex(video.currentTime)}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        toast('Clipboard unavailable — screenshot downloaded instead');
    }
}

// ------------------------------------------------------------------- export

// Source frame rate as an exact rational for the export filter graph.
// Metadata only: runtime estimates are capped at the display refresh rate
// (requestVideoFrameCallback fires per composited frame), so normalizing a
// high-fps source to an estimate would silently drop frames.
function fpsRational() {
    const info = state.current?.info;
    if (info?.fpsNum) return { num: info.fpsNum, den: info.fpsDen };
    return null;
}

function updateExportPanel() {
    const mode = $('encoderSel').value;
    const blockers = copyModeBlockers(state.segments, $('forceWide').checked);
    const note = $('copyNote');
    if (mode === 'copy') {
        if (blockers.length) {
            note.textContent = 'Stream copy unavailable with: ' + blockers.join(', ') + '.';
            note.hidden = false;
        } else {
            note.textContent = 'Stream copy cuts at keyframes — the clip may start slightly before your mark.';
            note.hidden = false;
        }
    } else {
        note.hidden = true;
    }
    $('btnExport').disabled = state.exporting || !state.current || !state.segments.length ||
        (mode === 'copy' && blockers.length > 0);
    if (state.segments.length && state.duration)
        $('exportEstimate').textContent = '≈ ' + outputDuration(state.segments, mode).toFixed(2) + 's output';
    else $('exportEstimate').textContent = '';
}

async function startExport() {
    if (state.exporting || !state.current) return;
    const mode = $('encoderSel').value;
    const forceWideScreen = $('forceWide').checked;
    const blockers = copyModeBlockers(state.segments, forceWideScreen);
    if (mode === 'copy' && blockers.length) return;
    if (state.segments.some(s => s.end - s.start <= 0)) {
        toast('A segment has zero length', true);
        return;
    }
    if (state.current.file.size > 1.5 * 1024 ** 3)
        toast('Heads up: files this large can exceed the browser ffmpeg memory limit', true);

    const outputName = safeFileName($('outName').value || 'clip') + '.mp4';
    state.exporting = true;
    $('btnCancelExport').hidden = false;
    $('exportProgressWrap').hidden = false;
    $('exportResult').hidden = true;
    $('exportLog').hidden = true;
    $('exportLog').textContent = '';
    setExportProgress(0, 'Starting…');
    updateExportPanel();

    try {
        const blob = await exportClip({
            file: state.current.file,
            segments: state.segments.map(s => ({ start: s.start, end: s.end, speed: s.speed, zoom: s.zoom })),
            hasAudio: state.current.info ? state.current.info.hasAudio : null,
            mode,
            forceWideScreen,
            outputName,
            fps: fpsRational(),
            onStatus: msg => setExportProgress(null, msg),
            onProgress: p => setExportProgress(p, (p * 100).toFixed(0) + '%'),
        });
        if (lastResultUrl) URL.revokeObjectURL(lastResultUrl);
        lastResultUrl = URL.createObjectURL(blob);
        const link = $('resultLink');
        link.href = lastResultUrl;
        link.download = outputName;
        link.textContent = `Save ${outputName} (${(blob.size / 1048576).toFixed(1)} MB)`;
        $('resultVideo').src = lastResultUrl;
        $('exportResult').hidden = false;
        setExportProgress(1, 'Done');
        link.click(); // auto-download; the link stays for re-saving
        toast('Clip created');
    } catch (err) {
        const cancelled = err?.canceled || /terminate|not loaded/i.test(String(err?.message));
        setExportProgress(0, cancelled ? 'Canceled' : 'Failed');
        if (!cancelled) {
            console.error(err);
            toast('Export failed: ' + err.message.split('\n')[0], true);
            $('exportLog').textContent = String(err.message);
            $('exportLog').hidden = false;
        }
    } finally {
        state.exporting = false;
        $('btnCancelExport').hidden = true;
        updateExportPanel();
    }
}

function setExportProgress(fraction, label) {
    if (fraction !== null) $('exportBar').style.width = (fraction * 100).toFixed(1) + '%';
    if (label) $('exportStatus').textContent = label;
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'VIDEO' || e.isComposing) return;
    // Leave browser/OS shortcuts (Ctrl+S, Cmd+arrows, …) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.current) return;
    switch (e.key) {
        case ' ':
            togglePlay();
            e.preventDefault();
            break;
        case 'ArrowRight':
        case '.':
            if (e.shiftKey) requestSeek(video.currentTime + 1);
            else stepFrame(1);
            e.preventDefault();
            break;
        case 'ArrowLeft':
        case ',':
            if (e.shiftKey) requestSeek(video.currentTime - 1);
            else stepFrame(-1);
            e.preventDefault();
            break;
        case '[': {
            const seg = segmentAt(video.currentTime) || state.segments[0];
            if (seg) setSegEdge(seg, 'start', video.currentTime, false);
            break;
        }
        case ']': {
            const seg = segmentAt(video.currentTime) || state.segments[state.segments.length - 1];
            if (seg) setSegEdge(seg, 'end', video.currentTime, false);
            break;
        }
        case 'Home':
            requestSeek(0);
            e.preventDefault();
            break;
        case 'End':
            requestSeek(state.duration);
            e.preventDefault();
            break;
        case 'm':
            $('muteChk').checked = !$('muteChk').checked;
            $('muteChk').dispatchEvent(new Event('change'));
            break;
        case 's':
            takeScreenshot();
            break;
    }
});

// ------------------------------------------------------------------- wiring

$('btnPlay').addEventListener('click', togglePlay);
$('btnPrevFrame').addEventListener('click', () => stepFrame(-1));
$('btnNextFrame').addEventListener('click', () => stepFrame(1));
$('btnAddSegment').addEventListener('click', addSegment);
$('btnScreenshot').addEventListener('click', takeScreenshot);
$('btnExport').addEventListener('click', startExport);
$('btnCancelExport').addEventListener('click', cancelExport);
$('encoderSel').addEventListener('change', () => {
    state.settings.encoder = $('encoderSel').value;
    saveSettings();
    updateExportPanel();
});
$('forceWide').addEventListener('change', () => {
    state.settings.forceWideScreen = $('forceWide').checked;
    saveSettings();
    updateExportPanel();
});
$('volume').addEventListener('input', () => {
    video.volume = parseFloat($('volume').value);
    state.settings.volume = video.volume;
    saveSettings();
});
$('muteChk').addEventListener('change', () => {
    video.muted = $('muteChk').checked;
    state.settings.muted = video.muted;
    saveSettings();
});

$('btnOpen').addEventListener('click', () => $('filePicker').click());
$('filePicker').addEventListener('change', e => {
    addFiles([...e.target.files]);
    e.target.value = '';
});

// Only react to external file drags — in-page drags (text selections, the
// result link) must keep their native behavior and not trigger the overlay.
const isFileDrag = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
});
window.addEventListener('dragleave', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (--dragDepth <= 0) {
        dragDepth = 0;
        dropOverlay.hidden = true;
    }
});
window.addEventListener('dragover', e => {
    if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener('drop', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});

// Apply persisted settings.
video.volume = state.settings.volume;
video.muted = state.settings.muted;
$('volume').value = String(state.settings.volume);
$('muteChk').checked = state.settings.muted;
$('encoderSel').value = state.settings.encoder;
$('forceWide').checked = state.settings.forceWideScreen;

drawFilmstripPlaceholder();
syncPlayButton();
updateExportPanel();
