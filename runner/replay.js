// Replays a painter recording and reports the states the project went through.
//
//   /runner/replay.html?build=<name>&project=<id>[&realtime][&trace][&dump=30,60]
//
// With trace (a job that is being traced), every script the compiler generates gets a sourceURL
// so its samples in the trace are attributed to it by line, and its source is posted along with
// the result so those lines can be read later (see hotlines.js).
//
// Without realtime, frames run back to back as fast as possible. wallMs is the time from the
// first frame until the GPU has finished the last one, minus hashing and snapshots. The result
// is shown, stored in window.replayResult, and posted to the parent window when running as a
// worker job (see worker.js).
//
// State hashes and stage snapshots are not checked here: floating point details and
// rasterization make them differ between browsers, devices and GPUs, so they are only compared
// between builds replayed in the same environment (see bench.js). The stage is captured at
// SNAPSHOTS frames evenly spread over the recording, including the last, and reported as hashes.
// With dump, the result also has the full state at those frames, for finding which value differs.

import {Runner, fnv1a} from './runner.js';
import {Stage} from './stage.js';
import {loadBuild, fetchProject, fetchRecording} from './recording.js';

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById('status');
const embedded = window.parent !== window;

// Progress is shown at most every STATUS_INTERVAL_MS, and the time it takes is not counted.
const STATUS_INTERVAL_MS = 500;
let statusMs = 0;
let lastStatus = -Infinity;
const status = (text, force) => {
    const start = performance.now();
    if (!force && start - lastStatus < STATUS_INTERVAL_MS) return;
    lastStatus = start;
    statusEl.textContent = text;
    statusMs += performance.now() - start;
};

// Hidden pages are throttled and the VM skips drawing, so their timings mean nothing.
let wasHidden = document.hidden;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) wasHidden = true;
});

// The compiler evaluates each script as new Function('globalState', source). Name those and keep
// their source; anything else passes through untouched.
const compiledSources = {};
if (params.has('trace')) {
    const RealFunction = window.Function;
    let count = 0;
    window.Function = new Proxy(RealFunction, {
        construct (target, args) {
            if (args.length === 2 && args[0] === 'globalState') {
                const match = args[1].match(/function\*? ((?:gen|fun)\d+(?:_[\w$]*)?)/);
                const url = `scratch/${count++}-${match ? match[1] : 'script'}.js`;
                compiledSources[url] = args[1];
                args = [args[0], `${args[1]}\n//# sourceURL=${url}`];
            }
            return Reflect.construct(target, args);
        }
    });
}

const gpuInfo = gl => {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

const nextAnimationFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

const SNAPSHOTS = 10;

const replay = async () => {
    const projectId = params.get('project');
    const label = `${projectId} on ${params.get('build')}`;
    status(`${label}: downloading`, true);
    const [{libs, info: build}, projectData, recording] = await Promise.all([
        loadBuild(params.get('build')),
        fetchProject(projectId),
        fetchRecording(projectId)
    ]);
    if (!recording) {
        throw new Error(`No recording for ${projectId}`);
    }

    const stage = new Stage(document.getElementById('stage'));
    const runner = new Runner({libs, canvas: stage.canvas, passes: recording.passes});
    stage.attach(runner);
    status(`${label}: loading project`, true);
    await runner.load(projectData);
    // For debugging from the console.
    window.runner = runner;
    if (runner.projectSha256 !== recording.projectSha256) {
        throw new Error('The project file is not the one that was recorded');
    }

    for (const frame of (params.get('dump') || '').split(',').filter(Boolean)) {
        runner.dumpFrames.add(Number(frame));
    }
    const wantedSnapshots = new Set(Array.from({length: SNAPSHOTS}, (_, i) => Math.ceil(recording.frames * (i + 1) / SNAPSHOTS)));
    const snapshots = {};
    const realtime = params.has('realtime');
    let next = 0;
    let snapshotMs = 0;
    statusMs = 0;
    // Marks the timed frames in traces (blink.user_timing).
    performance.mark('replay: frames start');
    const start = performance.now();
    while (runner.frame < recording.frames) {
        while (next < recording.inputs.length && recording.inputs[next].frame === runner.frame) {
            runner.input(recording.inputs[next++]);
        }
        await runner.step();
        if (runner.contextLostFrame !== null) {
            throw new Error(`WebGL context lost at frame ${runner.contextLostFrame}`);
        }
        if (wantedSnapshots.has(runner.frame)) {
            const snapshotStart = performance.now();
            snapshots[runner.frame] = fnv1a(runner.snapshot());
            snapshotMs += performance.now() - snapshotStart;
        }
        if (realtime) {
            await nextAnimationFrame();
        }
        const elapsed = performance.now() - start - runner.checkMs - snapshotMs - statusMs;
        status(`${label}: frame ${runner.frame} / ${recording.frames} ` +
            `(${Math.floor(runner.frame * 100 / recording.frames)}%), ${(elapsed / runner.frame).toFixed(2)} ms/frame`);
    }
    // Wait for the GPU to finish everything that was queued, so it counts too.
    const gl = runner.renderer.gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const wallMs = performance.now() - start - runner.checkMs - snapshotMs - statusMs;
    performance.mark('replay: frames end');
    performance.measure('replay: frames', 'replay: frames start', 'replay: frames end');
    // The event is delivered as a task, so give a loss during the last frame a chance to arrive.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (runner.contextLostFrame !== null) {
        throw new Error(`WebGL context lost at frame ${runner.contextLostFrame}`);
    }

    return {
        project: projectId,
        build: build.name,
        frames: runner.frame,
        executeMs: runner.executeMs,
        drawMs: runner.drawMs,
        wallMs,
        msPerFrame: wallMs / runner.frame,
        hidden: wasHidden,
        gpu: gpuInfo(gl),
        userAgent: navigator.userAgent,
        // Whether performance.now() had its full resolution.
        crossOriginIsolated: window.crossOriginIsolated,
        checks: runner.checks(),
        // Hashes of the stage (as a PNG data URL) by frame.
        snapshots,
        ...(runner.dumpFrames.size ? {dumps: runner.dumps} : {}),
        errors: runner.errors,
        compileErrors: runner.compileErrors
    };
};

replay().then(result => {
    window.replayResult = result;
    if (embedded) {
        window.parent.postMessage({type: 'job-result', result, artifacts: {compiledSources}}, location.origin);
    }
    window.compiledSources = compiledSources;
    status([
        `${result.project}: final state hash ${result.checks.final.hash} after ${result.frames} frames`,
        `scripts ${(result.executeMs / 1000).toFixed(2)} s, draw ${(result.drawMs / 1000).toFixed(2)} s, wall ${(result.wallMs / 1000).toFixed(2)} s`,
        ...Object.entries(result.dumps || {}).map(([frame, dump]) => `frame ${frame}:\n  ${Object.entries(dump).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n  ')}`),
        result.errors.length ? `errors: ${result.errors.join('; ')}` : ''
    ].filter(Boolean).join('\n'), true);
}, e => {
    window.replayResult = {error: String(e.stack || e)};
    if (embedded) {
        window.parent.postMessage({type: 'job-error', error: String(e.stack || e)}, location.origin);
    }
    status(`Error: ${e.stack || e}`, true);
});
