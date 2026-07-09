// Minimal ISO BMFF (MP4) parser.
//
// Frame-accurate stepping needs the video track's exact frame rate, which the
// HTML5 video API does not expose. This walks the top-level boxes of the file
// (skipping mdat without reading it), pulls the moov box into memory, and
// derives fps from the sample table: fps = timescale * samples / totalDelta.
// Also reports whether the file has an audio track, which drives the audio
// half of the export filter graph.

const MAX_MOOV_BYTES = 100 * 1024 * 1024;

function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
}

async function readAt(file, offset, length) {
    const buf = await file.slice(offset, offset + length).arrayBuffer();
    return new DataView(buf);
}

function fourcc(view, offset) {
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    );
}

// Walk top-level boxes reading only headers until moov is found, then load it.
async function findMoov(file) {
    let offset = 0;
    const fileSize = file.size;
    while (offset + 8 <= fileSize) {
        const headLen = Math.min(16, fileSize - offset);
        const head = await readAt(file, offset, headLen);
        let boxSize = head.getUint32(0);
        const type = fourcc(head, 4);
        let headerLen = 8;
        if (boxSize === 1) {
            if (headLen < 16) return null;
            boxSize = Number(head.getBigUint64(8));
            headerLen = 16;
        } else if (boxSize === 0) {
            boxSize = fileSize - offset;
        }
        if (boxSize < headerLen) return null; // corrupt box, bail out
        if (type === 'moov') {
            if (boxSize > MAX_MOOV_BYTES) return null;
            // Content only — callers walk child boxes from offset 0.
            const contentStart = offset + headerLen;
            const contentEnd = Math.min(offset + boxSize, fileSize);
            return readAt(file, contentStart, contentEnd - contentStart);
        }
        offset += boxSize;
    }
    return null;
}

// Yields {type, start, end} for each child box in view[start, end).
// start/end of the yielded entry delimit the box *content* (header excluded).
function* childBoxes(view, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
        let boxSize = view.getUint32(offset);
        const type = fourcc(view, offset + 4);
        let headerLen = 8;
        if (boxSize === 1) {
            if (offset + 16 > end) return;
            boxSize = Number(view.getBigUint64(offset + 8));
            headerLen = 16;
        } else if (boxSize === 0) {
            boxSize = end - offset;
        }
        if (boxSize < headerLen || offset + boxSize > end) return;
        yield { type, start: offset + headerLen, end: offset + boxSize };
        offset += boxSize;
    }
}

function findChild(view, start, end, type) {
    for (const box of childBoxes(view, start, end))
        if (box.type === type) return box;
    return null;
}

function parseMdhd(view, box) {
    // An all-ones duration is the spec's "unknown" sentinel (fragmented
    // recordings) — report 0 so callers treat it as absent.
    const version = view.getUint8(box.start);
    if (version === 1) {
        const duration = view.getBigUint64(box.start + 24);
        return {
            timescale: view.getUint32(box.start + 20),
            duration: duration === 0xffffffffffffffffn ? 0 : Number(duration),
        };
    }
    const duration = view.getUint32(box.start + 16);
    return {
        timescale: view.getUint32(box.start + 12),
        duration: duration === 0xffffffff ? 0 : duration,
    };
}

// Sum of sample counts and total duration (in track timescale) from stts.
function parseStts(view, box) {
    const entryCount = view.getUint32(box.start + 4);
    let samples = 0;
    let totalDelta = 0;
    let offset = box.start + 8;
    for (let i = 0; i < entryCount && offset + 8 <= box.end; i++, offset += 8) {
        const count = view.getUint32(offset);
        const delta = view.getUint32(offset + 4);
        samples += count;
        totalDelta += count * delta;
    }
    return { samples, totalDelta };
}

function parseTrak(view, trak) {
    const mdia = findChild(view, trak.start, trak.end, 'mdia');
    if (!mdia) return null;
    const mdhd = findChild(view, mdia.start, mdia.end, 'mdhd');
    const hdlr = findChild(view, mdia.start, mdia.end, 'hdlr');
    if (!mdhd || !hdlr) return null;
    const handler = fourcc(view, hdlr.start + 8); // after version/flags + pre_defined
    const { timescale, duration } = parseMdhd(view, mdhd);

    let samples = 0;
    let totalDelta = 0;
    const minf = findChild(view, mdia.start, mdia.end, 'minf');
    const stbl = minf && findChild(view, minf.start, minf.end, 'stbl');
    const stts = stbl && findChild(view, stbl.start, stbl.end, 'stts');
    if (stts) ({ samples, totalDelta } = parseStts(view, stts));

    return { handler, timescale, duration, samples, totalDelta };
}

// Returns {fps, frameCount, videoDuration, hasAudio, hasVideo} or null when
// the file is not parseable MP4 (caller falls back to runtime fps estimation).
export async function parseMp4Info(file) {
    let moov;
    try {
        moov = await findMoov(file);
    } catch {
        return null;
    }
    if (!moov) return null;

    const info = {
        fps: null,
        fpsNum: null, // exact rational frame rate: fpsNum/fpsDen
        fpsDen: null,
        frameCount: 0,
        videoDuration: null,
        hasAudio: false,
        hasVideo: false,
    };
    // A truncated or corrupt trak is indistinguishable from an absent one, so
    // any parse anomaly downgrades hasAudio to null ("unknown") — the export
    // path then probes the file with ffmpeg itself instead of silently
    // dropping audio that ffmpeg could have salvaged.
    let suspect = false;
    let walked = 0;
    for (const box of childBoxes(moov, 0, moov.byteLength)) {
        walked = box.end;
        if (box.type !== 'trak') continue;
        let track;
        try {
            track = parseTrak(moov, box);
        } catch {
            suspect = true;
            continue;
        }
        if (!track) {
            suspect = true;
            continue;
        }
        if (track.handler === 'soun') info.hasAudio = true;
        if (track.handler === 'vide' && !info.hasVideo) {
            info.hasVideo = true;
            info.frameCount = track.samples;
            if (track.timescale > 0 && track.duration > 0)
                info.videoDuration = track.duration / track.timescale;
            if (track.totalDelta > 0 && track.samples > 0 && track.timescale > 0) {
                const fps = (track.timescale * track.samples) / track.totalDelta;
                if (fps >= 1 && fps <= 1000) {
                    info.fps = fps;
                    const g = gcd(track.timescale * track.samples, track.totalDelta);
                    info.fpsNum = (track.timescale * track.samples) / g;
                    info.fpsDen = track.totalDelta / g;
                }
            }
        }
    }
    // Clean moov children tile the content exactly; a short walk means a
    // child box (possibly a trak) was dropped as truncated or overrunning.
    if (walked < moov.byteLength) suspect = true;
    if (suspect && !info.hasAudio) info.hasAudio = null;
    return info.hasVideo || info.hasAudio ? info : null;
}
