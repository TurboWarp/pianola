// Traces the worker's tab around each job and uploads the trace to the server.
//
// Requests from the worker page (through content.js):
//   {type: 'hello'}                     -> {ok, version}
//   {type: 'start', categories?}        -> {ok}; attaches the debugger if needed and starts tracing
//   {type: 'stop', uploadUrl?}          -> {ok, bytes}; ends tracing, gzips the trace, POSTs it to
//                                          uploadUrl (or discards it without one)
//
// Traces are Perfetto protobuf rather than JSON: Chrome records in protobuf, and converting to
// JSON at the end took about as much memory again as the trace itself, enough to crash a
// Chromebook. Protobuf traces are also about a third of the size.
//
// Extensions other than Perfetto's own can only attach to tabs, not to the whole browser, so
// this records what the DevTools Performance panel records: the tab's renderer process,
// including JavaScript samples, plus what Chrome attributes to it from other processes.
//
// The service worker can be stopped between messages, so nothing here relies on state kept in
// memory between a start and its stop.

// Close to what the DevTools Performance panel records.
const DEFAULT_CATEGORIES = [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'toplevel',
    'blink.console',
    'blink.user_timing',
    'latencyInfo',
    'v8.execute',
    'v8',
    'gpu',
    'cc',
    'viz'
];

const send = (target, method, params) => chrome.debugger.sendCommand(target, method, params);

const attach = async target => {
    try {
        await chrome.debugger.attach(target, '1.3');
    } catch (e) {
        // Still attached from an earlier job, which keeps Chrome's debugging infobar from flickering.
        if (!/already attached/i.test(e.message)) throw e;
    }
};

const waitForEvent = (tabId, eventName) => new Promise(resolve => {
    const listener = (source, method, params) => {
        if (source.tabId === tabId && method === eventName) {
            chrome.debugger.onEvent.removeListener(listener);
            resolve(params);
        }
    };
    chrome.debugger.onEvent.addListener(listener);
});

const start = async (tabId, categories) => {
    const target = {tabId};
    await attach(target);
    const params = {
        transferMode: 'ReturnAsStream',
        streamFormat: 'proto',
        traceConfig: {recordMode: 'recordAsMuchAsPossible', includedCategories: categories || DEFAULT_CATEGORIES}
    };
    try {
        await send(target, 'Tracing.start', params);
    } catch (e) {
        // A trace left running by a job that never finished; throw it away and start over.
        // ("Tracing has already been started (possibly in another tab).")
        if (!/already (been )?started/i.test(e.message)) throw e;
        const done = waitForEvent(tabId, 'Tracing.tracingComplete');
        try {
            await send(target, 'Tracing.end');
        } catch (endError) {
            throw new Error(`another tab or DevTools is already tracing; close it (${endError.message})`);
        }
        const {stream} = await done;
        if (stream) await send(target, 'IO.close', {handle: stream});
        await send(target, 'Tracing.start', params);
    }
    return {};
};

const stop = async (tabId, uploadUrl) => {
    const target = {tabId};
    const done = waitForEvent(tabId, 'Tracing.tracingComplete');
    await send(target, 'Tracing.end');
    const {stream} = await done;
    if (!uploadUrl) {
        // The job failed; nothing to keep.
        await send(target, 'IO.close', {handle: stream});
        return {bytes: 0};
    }

    // Read the trace in chunks and gzip it as it comes; traces can be hundreds of MB.
    const gzip = new CompressionStream('gzip');
    const writer = gzip.writable.getWriter();
    const compressed = new Response(gzip.readable).blob();
    let bytes = 0;
    for (;;) {
        const chunk = await send(target, 'IO.read', {handle: stream, size: 1 << 20});
        const data = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
        bytes += data.length;
        await writer.write(data);
        if (chunk.eof) break;
    }
    await writer.close();
    await send(target, 'IO.close', {handle: stream});

    const body = await compressed;
    const res = await fetch(uploadUrl, {method: 'POST', headers: {'content-type': 'application/gzip'}, body});
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
    return {bytes, compressedBytes: body.size};
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab && sender.tab.id;
    const handlers = {
        hello: async () => ({version: chrome.runtime.getManifest().version}),
        start: () => start(tabId, request.categories),
        stop: () => stop(tabId, request.uploadUrl)
    };
    const handler = handlers[request.type];
    if (!handler) return false;
    handler().then(
        result => sendResponse({ok: true, ...result}),
        error => sendResponse({ok: false, error: String(error && error.message || error)})
    );
    // Responds asynchronously.
    return true;
});
