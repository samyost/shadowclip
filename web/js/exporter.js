// In-browser clip export via ffmpeg.wasm.
//
// Uses the single-threaded @ffmpeg/core build, which works without
// COOP/COEP headers so the app can be hosted from any static file server
// (including GitHub Pages). The engine (~31 MB) is fetched from a CDN the
// first time an export runs; files being edited never leave the machine.
//
// The filter graph mirrors the desktop app's FfmpegEncoder: per-segment
// trim/atrim + setpts reset, optional center zoom (scale+crop), optional
// speed change (setpts / atempo chain), then concat of every segment.

const DEFAULT_URLS = {
    ffmpegJs: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
    // Self-contained module worker vendored in this repo (see the header of
    // that file for why the stock package's worker can't be used from a CDN).
    // FFmpeg#load() runs classWorkerURL workers with { type: "module" }, so
    // the core must be the ESM build, whose default export the worker imports.
    ffmpegWorkerJs: new URL('../vendor/ffmpeg-worker.js', import.meta.url).href,
    utilJs: 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js',
    coreJs: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
    coreWasm: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
};

// Overridable so tests (or self-hosting users) can serve the engine locally.
function engineUrls() {
    return Object.assign({}, DEFAULT_URLS, window.SHADOWCLIP_FFMPEG_URLS || {});
}

function fmtNum(value) {
    // Fixed-point, never exponent notation, no trailing zeros noise.
    return Number(value.toFixed(6)).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

// Reasons stream-copy cannot be used, mirroring the desktop restrictions.
// Empty array means copy mode is allowed.
export function copyModeBlockers(segments, forceWideScreen) {
    const blockers = [];
    if (segments.length > 1) blockers.push('more than one segment');
    if (segments.some(s => s.speed !== 1)) blockers.push('speed change');
    if (segments.some(s => s.zoom !== 1)) blockers.push('zoom');
    if (forceWideScreen) blockers.push('force 16:9');
    return blockers;
}

// Decompose a speed ratio into atempo factors, each within atempo's
// supported [0.5, 2] range. Equivalent to the desktop chain for its
// 0.25x-4x presets, but correct for arbitrary values too.
function atempoFactors(speed) {
    const factors = [];
    let remaining = speed;
    while (remaining > 2) {
        factors.push(2);
        remaining /= 2;
    }
    while (remaining < 0.5) {
        factors.push(0.5);
        remaining /= 0.5;
    }
    factors.push(remaining);
    return factors;
}

// `fps` is the source's rational frame rate ({num, den}) when known. It is
// only used when a segment changes speed: mixed-rate concat output otherwise
// gets its timestamps quantized to the guessed encoder frame rate (observed
// on the ffmpeg 5.1 wasm core), so we normalize back to the source rate.
export function buildExportArgs({ segments, hasAudio, mode, forceWideScreen, inputName, outputName, fps = null }) {
    if (mode === 'copy') {
        const seg = segments[0];
        return [
            '-ss', fmtNum(seg.start),
            '-i', inputName,
            '-t', fmtNum(seg.end - seg.start),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', 'faststart',
            '-f', 'mp4',
            '-y', outputName,
        ];
    }

    let filter = '';
    const concatInputs = [];
    segments.forEach((seg, i) => {
        const idx = i + 1;
        const dur = seg.end - seg.start;
        const hasSpeed = seg.speed !== 1;
        const suffix = hasSpeed ? 'tmp' : '';
        const zoomFilter = seg.zoom > 1
            ? `,scale=${seg.zoom}*iw:-1,crop=iw/${seg.zoom}:ih/${seg.zoom}`
            : '';
        filter += `[0:v]trim=start=${fmtNum(seg.start)}:duration=${fmtNum(dur)},setpts=PTS-STARTPTS${zoomFilter}[v${idx}${suffix}];`;
        if (hasAudio)
            filter += `[0:a]atrim=start=${fmtNum(seg.start)}:duration=${fmtNum(dur)},asetpts=PTS-STARTPTS[a${idx}${suffix}];`;
        if (hasSpeed) {
            filter += `[v${idx}tmp]setpts=PTS/${fmtNum(seg.speed)}[v${idx}];`;
            if (hasAudio) {
                const chain = atempoFactors(seg.speed).map(f => `atempo=${fmtNum(f)}`).join(',');
                filter += `[a${idx}tmp]${chain}[a${idx}];`;
            }
        }
        concatInputs.push(hasAudio ? `[v${idx}][a${idx}]` : `[v${idx}]`);
    });

    const audioFlag = hasAudio ? 1 : 0;
    const outPads = hasAudio ? '[vcat][acat]' : '[vcat]';
    filter += `${concatInputs.join('')}concat=n=${segments.length}:v=1:a=${audioFlag}${outPads}`;

    let videoPad = '[vcat]';
    if (fps && segments.some(s => s.speed !== 1)) {
        filter += `;${videoPad}fps=${fps.num}/${fps.den}[vnorm]`;
        videoPad = '[vnorm]';
    }
    if (forceWideScreen) {
        filter += `;${videoPad}setdar=16/9[vfinal]`;
        videoPad = '[vfinal]';
    }

    return [
        '-i', inputName,
        '-filter_complex', filter,
        '-map', videoPad,
        ...(hasAudio ? ['-map', '[acat]', '-c:a', 'aac', '-b:a', '192k'] : []),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '25',
        '-pix_fmt', 'yuv420p',
        // Keep the filter graph's exact timestamps: with the default CFR
        // snapping, segments whose speed differs from the first segment get
        // frames dropped/duplicated and their timing subtly mangled.
        '-vsync', 'vfr',
        '-movflags', 'faststart',
        '-f', 'mp4',
        '-y', outputName,
    ];
}

// Duration of the finished clip in seconds (speed changes included).
export function outputDuration(segments, mode) {
    if (mode === 'copy') return segments[0].end - segments[0].start;
    return segments.reduce((sum, s) => sum + (s.end - s.start) / s.speed, 0);
}

let scriptsLoaded = null;
let enginePromise = null;
let engine = null;
const logListeners = new Set();
const progressListeners = new Set();

function injectScript(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(el);
    });
}

async function loadEngine(onStatus) {
    if (engine) return engine;
    if (!enginePromise) {
        enginePromise = (async () => {
            const urls = engineUrls();
            onStatus?.('Downloading ffmpeg engine…');
            if (!scriptsLoaded)
                scriptsLoaded = Promise.all([injectScript(urls.ffmpegJs), injectScript(urls.utilJs)]);
            await scriptsLoaded;
            const { FFmpeg } = window.FFmpegWASM;
            const { toBlobURL } = window.FFmpegUtil;
            const ff = new FFmpeg();
            ff.on('log', ({ message }) => logListeners.forEach(fn => fn(message)));
            ff.on('progress', ({ time }) => progressListeners.forEach(fn => fn(time)));
            await ff.load({
                coreURL: await toBlobURL(urls.coreJs, 'text/javascript'),
                wasmURL: await toBlobURL(urls.coreWasm, 'application/wasm'),
                classWorkerURL: await toBlobURL(urls.ffmpegWorkerJs, 'text/javascript'),
            });
            engine = ff;
            return ff;
        })().catch(err => {
            enginePromise = null;
            scriptsLoaded = null; // a failed script load must be retryable
            throw new Error(
                'Could not load the ffmpeg engine (are you offline, or is the CDN blocked?): ' + err.message
            );
        });
    }
    return enginePromise;
}

// Bumped on every cancel; exportClip aborts at its next checkpoint. Needed
// because terminate() only rejects in-flight worker calls — cancels landing
// during the engine download or file read would otherwise be lost.
let cancelSeq = 0;

export function cancelExport() {
    cancelSeq++;
    if (!engine) return;
    try {
        engine.terminate();
    } catch {
        // already dead
    }
    engine = null;
    enginePromise = null;
}

// Runs the export and resolves with a Blob of the finished MP4.
// hasAudio may be null (container the MP4 parser couldn't read) — the engine
// probes the file itself in that case.
export async function exportClip({ file, segments, hasAudio, mode, forceWideScreen, outputName, fps, onProgress, onStatus, onLog }) {
    const seq = cancelSeq;
    const throwIfCancelled = () => {
        if (cancelSeq !== seq) {
            const err = new Error('Export canceled');
            err.canceled = true;
            throw err;
        }
    };

    const ff = await loadEngine(onStatus);
    throwIfCancelled();

    const extMatch = /\.([A-Za-z0-9]+)$/.exec(file.name);
    let inputName = 'input.' + (extMatch ? extMatch[1].toLowerCase() : 'mp4');
    if (outputName === inputName) inputName = 'in_' + inputName;

    const totalOut = outputDuration(segments, mode);
    const logTail = [];
    const logFn = message => {
        logTail.push(message);
        if (logTail.length > 40) logTail.shift();
        onLog?.(message);
    };
    const progressFn = timeMicros => {
        if (totalOut > 0 && Number.isFinite(Number(timeMicros)))
            onProgress?.(Math.min(1, Math.max(0, Number(timeMicros) / 1e6 / totalOut)));
    };
    logListeners.add(logFn);
    progressListeners.add(progressFn);

    try {
        onStatus?.('Reading file…');
        const data = new Uint8Array(await file.arrayBuffer());
        throwIfCancelled();
        await ff.writeFile(inputName, data);
        throwIfCancelled();

        let audio = hasAudio;
        if (audio == null && mode !== 'copy') {
            // '-i' alone exits nonzero but prints the stream list to the log.
            const probeLines = [];
            const probeFn = m => probeLines.push(m);
            logListeners.add(probeFn);
            try {
                await ff.exec(['-hide_banner', '-i', inputName]);
            } finally {
                logListeners.delete(probeFn);
            }
            audio = probeLines.some(l => /Stream #\d+:\d+.*: Audio/.test(l));
            throwIfCancelled();
        }

        const args = buildExportArgs({ segments, hasAudio: !!audio, mode, forceWideScreen, inputName, outputName, fps });
        onStatus?.(mode === 'copy' ? 'Copying streams…' : 'Encoding…');
        const rc = await ff.exec(args);
        if (rc !== 0)
            throw new Error(`ffmpeg exited with code ${rc}\n${logTail.slice(-8).join('\n')}`);
        const out = await ff.readFile(outputName);
        if (!out || out.length === 0) throw new Error('ffmpeg produced an empty file');
        return new Blob([out.buffer], { type: 'video/mp4' });
    } finally {
        logListeners.delete(logFn);
        progressListeners.delete(progressFn);
        if (engine === ff) {
            for (const name of [inputName, outputName]) {
                try {
                    await ff.deleteFile(name);
                } catch {
                    // never written or already gone
                }
            }
        }
    }
}
