// Runs jobs from the server's queue, one at a time, each in a fresh iframe. Open this page on
// any device that can reach the server; open it in several tabs or windows to run jobs in
// parallel (at the cost of noisier timings).
//
//   /runner/worker.html[?name=<device name>]
//
// A job page reports back with parent.postMessage({type: 'job-result', result}) or
// {type: 'job-error', error}. Jobs with meta.trace are traced with the tracer extension
// (profiler-extension/) and only go to workers that have it. The status line is only updated between jobs so that it never
// competes with a measurement.

import {detectAlteredReadback} from './readback.js';

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById('status');
const jobEl = document.getElementById('job');

const HEARTBEAT_MS = 5000;
const RETRY_MS = 5000;

if (params.has('name')) {
    localStorage.setItem('worker-name', params.get('name'));
}
const name = localStorage.getItem('worker-name') || navigator.platform || 'worker';

const readbackProblem = detectAlteredReadback();
if (readbackProblem) {
    const warning = document.getElementById('readback-warning');
    warning.textContent = `Warning: ${readbackProblem} (anti-fingerprinting). Projects that read pixels behave randomly here, so their state checks fail. Use a browser without it, or turn it off for this site.`;
    warning.hidden = false;
}
// One per tab, so several tabs on one device are separate workers.
const workerId = `${name}-${Math.random().toString(36).slice(2, 8)}`;

const stats = {done: 0, failed: 0};

// Calls into the tracer extension, through its content script.
const tracerCalls = new Map();
let nextTracerCall = 0;
window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'benchmark-tracer-extension') return;
    const callback = tracerCalls.get(e.data.id);
    if (callback) {
        tracerCalls.delete(e.data.id);
        callback(e.data.response);
    }
});
const tracer = (request, timeoutMs = 10 * 60000) => new Promise((resolve, reject) => {
    const id = nextTracerCall++;
    const timer = setTimeout(() => {
        tracerCalls.delete(id);
        reject(new Error('the tracer extension did not answer'));
    }, timeoutMs);
    tracerCalls.set(id, response => {
        clearTimeout(timer);
        if (response && response.ok) resolve(response);
        else reject(new Error((response && response.error) || 'no response'));
    });
    window.postMessage({source: 'benchmark-tracer-page', id, request}, '*');
});
const canTrace = tracer({type: 'hello'}, 1000).then(() => true, () => false);

/** Keep the job's lease while doing something slow after the job itself, like uploading a trace. */
const withHeartbeat = async (job, promise) => {
    const heartbeat = setInterval(() => {
        post(`/api/queue/jobs/${job.id}/heartbeat`, {worker: workerId}).catch(() => {});
    }, HEARTBEAT_MS);
    try {
        return await promise;
    } finally {
        clearInterval(heartbeat);
    }
};
let lastError = '';
let queueStatus = null;

const formatDuration = ms => {
    if (ms === null || ms === undefined) return '?';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
};

const describeJob = job => {
    const meta = job.meta && typeof job.meta === 'object' ?
        Object.entries(job.meta).map(([k, v]) => `${k}=${v}`).join(' ') :
        job.url;
    return `job ${job.id} (batch ${job.batch}) ${meta}`;
};

const render = state => {
    const q = queueStatus;
    const counts = q ? q.counts : {};
    statusEl.textContent = [
        `${workerId}  ${state}`,
        q ?
            `queue: ${counts.pending || 0} pending  ${counts.running || 0} running  ${counts.done || 0} done  ` +
            `${counts.failed || 0} failed  eta ${formatDuration(q.etaMs)}  avg job ${formatDuration(q.avgJobMs)}  ` +
            `${q.workers.length} workers` :
            'queue: ?',
        `this tab: ${stats.done} done  ${stats.failed} failed  tracing ${tracingAvailable ? 'available' : 'off'}` +
            (lastError ? `  last error: ${lastError}` : '')
    ].join('\n');
};

const post = async (url, body) => {
    const res = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
    return res.json();
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const whenVisible = () => new Promise(resolve => {
    if (!document.hidden) return resolve();
    const onChange = () => {
        if (!document.hidden) {
            document.removeEventListener('visibilitychange', onChange);
            resolve();
        }
    };
    document.addEventListener('visibilitychange', onChange);
});

// Tablets and phones turn their screens off and then throttle or freeze the page.
const wakeLockWarning = document.getElementById('wake-lock-warning');
let wakeLock = null;
const showWakeLockWarning = () => {
    wakeLockWarning.textContent = navigator.wakeLock ?
        'The screen is not being kept awake. Tap anywhere on this page to keep it on.' :
        'The screen cannot be kept awake on this page (it needs https). Keep it on another way.';
    wakeLockWarning.hidden = false;
};
const keepAwake = async () => {
    if (!navigator.wakeLock) return showWakeLockWarning();
    if (wakeLock && !wakeLock.released) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLockWarning.hidden = true;
        wakeLock.addEventListener('release', showWakeLockWarning);
    } catch (e) {
        // Safari only grants the lock during a user gesture.
        showWakeLockWarning();
    }
};
// Click rather than pointerdown, which the spec only counts as a gesture for mice.
document.addEventListener('click', () => keepAwake());

/** @returns {Promise<{result?: object, error?: string}>} */
const runJob = job => new Promise(resolve => {
    const iframe = document.createElement('iframe');
    let finished = false;
    const finish = outcome => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        document.removeEventListener('visibilitychange', onVisibility);
        iframe.remove();
        resolve(outcome);
    };
    const onMessage = e => {
        if (e.source !== iframe.contentWindow || e.origin !== location.origin) return;
        if (e.data.type === 'job-result') finish({result: e.data.result, artifacts: e.data.artifacts});
        if (e.data.type === 'job-error') finish({error: e.data.error});
    };
    const onVisibility = () => {
        if (document.hidden) finish({error: 'the worker tab was hidden'});
    };
    const heartbeat = setInterval(() => {
        post(`/api/queue/jobs/${job.id}/heartbeat`, {worker: workerId}).then(({ok}) => {
            if (!ok) finish({abandoned: true});
        }, () => {});
    }, HEARTBEAT_MS);
    const timeout = setTimeout(() => finish({error: `timed out after ${formatDuration(job.timeoutMs)}`}), job.timeoutMs);
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisibility);
    iframe.src = job.url;
    jobEl.appendChild(iframe);
});

let tracingAvailable = false;

const main = async () => {
    tracingAvailable = await canTrace;
    for (;;) {
        if (document.hidden) {
            render('paused: tab hidden');
            await whenVisible();
        }
        await keepAwake();
        render('waiting for a job');
        let claimed;
        try {
            claimed = await post('/api/queue/claim', {worker: workerId, name, userAgent: navigator.userAgent, tracing: tracingAvailable, readbackAltered: !!readbackProblem});
        } catch (e) {
            lastError = `server unreachable: ${e.message}`;
            render('retrying');
            await sleep(RETRY_MS);
            continue;
        }
        queueStatus = claimed.status;
        const job = claimed.job;
        if (!job) continue;

        render(`running ${describeJob(job)}`);
        const traced = !!(job.meta && job.meta.trace);
        let outcome;
        try {
            if (traced) await tracer({type: 'start'});
            outcome = await runJob(job);
        } catch (e) {
            outcome = {error: `could not start tracing: ${e.message}`};
        }
        if (traced) {
            render(`uploading the trace of ${describeJob(job)}`);
            const uploadUrl = outcome.result ?
                `${location.origin}/api/queue/jobs/${job.id}/trace?worker=${encodeURIComponent(workerId)}` :
                null;
            try {
                const {bytes, compressedBytes} = await withHeartbeat(job, tracer({type: 'stop', uploadUrl}));
                if (outcome.result) {
                    outcome.result.trace = {bytes, compressedBytes};
                    // The compiled scripts, to read the lines the trace attributes time to.
                    const sources = (outcome.artifacts && outcome.artifacts.compiledSources) || {};
                    const gzipped = new Response(new Blob([JSON.stringify(sources)]).stream()
                        .pipeThrough(new CompressionStream('gzip'))).blob();
                    const res = await withHeartbeat(job, gzipped.then(body => fetch(
                        `/api/queue/jobs/${job.id}/sources?worker=${encodeURIComponent(workerId)}`,
                        {method: 'POST', headers: {'content-type': 'application/gzip'}, body}
                    )));
                    if (!res.ok) throw new Error(`uploading compiled sources: ${res.status}`);
                    outcome.result.trace.compiledScripts = Object.keys(sources).length;
                }
            } catch (e) {
                if (outcome.result) outcome.result.traceError = e.message;
            }
        }
        try {
            if (outcome.result) {
                await post(`/api/queue/jobs/${job.id}/result`, {worker: workerId, result: outcome.result});
                stats.done++;
            } else if (outcome.error) {
                await post(`/api/queue/jobs/${job.id}/fail`, {worker: workerId, error: outcome.error});
                stats.failed++;
                lastError = `job ${job.id}: ${outcome.error.split('\n')[0]}`;
            }
        } catch (e) {
            lastError = `could not report job ${job.id}: ${e.message}`;
        }
    }
};

main();
