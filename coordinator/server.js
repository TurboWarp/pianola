// The coordinator: serves the runner pages, the painter and builds, and keeps the job queue for workers.
//
//   node coordinator/server.js [--host 127.0.0.1] [--port 8100] [--recordings <dir>] [--queue <file>]
//
// Use --host 0.0.0.0 (or a Tailscale address) to let other machines run jobs.
//
//   /painter/, /runner/          pages; devices open /runner/ to start a worker
//   /builds/<name>/...           bundles of scratch-vm builds
//   /runner/extension.zip        the tracer extension (profiler-extension/), to load unpacked
//   /api/builds                  list of builds
//   /api/projects                list of projects in corpus.json, with title, author and recording info
//   /api/projects/<id>           project file, downloaded from corpus.json's URL the first time
//   /api/recordings/<id>         recordings/<id>.json; PUT replaces it
//   /api/queue/...               the job queue, see handleQueue()
//   results/traces/<job>.pftrace.gz Chrome traces (Perfetto protobuf) uploaded by the tracer extension

import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseArgs, promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {Queue} from './queue.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORPUS = JSON.parse(fs.readFileSync(path.join(ROOT, 'corpus.json'), 'utf8'));
// Project files, named by their SHA-256 like the corpus URLs, so a changed URL is a new download.
const PROJECT_CACHE = path.join(ROOT, '.cache', 'projects');
const {values} = parseArgs({
    options: {
        host: {type: 'string', default: '127.0.0.1'},
        port: {type: 'string', default: '8100'},
        queue: {type: 'string', default: path.join(ROOT, 'results', 'queue.sqlite')},
        // Somewhere else to read and write recordings, e.g. for testing the painter.
        recordings: {type: 'string', default: path.join(ROOT, 'recordings')}
    }
});
const RECORDINGS = path.resolve(values.recordings);
const queue = new Queue(path.resolve(values.queue));
const TRACES = path.join(path.dirname(path.resolve(values.queue)), 'traces');
// How long a worker's request for a job waits for one to arrive.
const CLAIM_WAIT_MS = 20000;

// Perfetto's traceconv converts protobuf traces to JSON for the DevTools Performance panel, which
// only reads JSON. Install it with: curl -L -o .cache/traceconv https://get.perfetto.dev/traceconv
// (a Python script that downloads and checks the actual converter on first use).
const TRACECONV = path.join(ROOT, '.cache', 'traceconv');

/** Gzipped JSON version of a gzipped protobuf trace, made next to it the first time it is asked for. */
const traceAsJSON = async protoFile => {
    const jsonFile = protoFile.replace(/\.pftrace\.gz$/, '.converted.json.gz');
    if (fs.existsSync(jsonFile)) return jsonFile;
    if (!fs.existsSync(TRACECONV)) {
        throw new HttpError(501, 'No traceconv; download https://get.perfetto.dev/traceconv to .cache/traceconv');
    }
    const temp = fs.mkdtempSync(path.join(path.dirname(protoFile), '.convert-'));
    try {
        const input = path.join(temp, 'trace.pftrace');
        const output = path.join(temp, 'trace.json');
        fs.writeFileSync(input, zlib.gunzipSync(fs.readFileSync(protoFile)));
        await promisify(execFile)('python3', ['-I', TRACECONV, 'json', input, output], {maxBuffer: 1 << 26});
        await new Promise((resolve, reject) => {
            fs.createReadStream(output).pipe(zlib.createGzip()).pipe(fs.createWriteStream(`${jsonFile}.tmp`))
                .on('finish', resolve).on('error', reject);
        });
        fs.renameSync(`${jsonFile}.tmp`, jsonFile);
        return jsonFile;
    } finally {
        fs.rmSync(temp, {recursive: true, force: true});
    }
};
const BUILDS = path.join(ROOT, 'dist', 'builds');
const STATIC = {
    '/runner/': path.join(ROOT, 'runner'),
    '/painter/': path.join(ROOT, 'painter'),
    '/builds/': BUILDS
};
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};
const SAFE_NAME = /^[\w.-]+$/;

class HttpError extends Error {
    constructor (status, message) {
        super(message);
        this.status = status;
    }
}

const sendJSON = (res, value) => {
    res.writeHead(200, {'content-type': TYPES['.json'], 'cache-control': 'no-store'});
    res.end(JSON.stringify(value));
};

// Revalidated on every use, so changes show up right away but unchanged files (large projects
// fetched by remote workers for every job) are not sent again.
const sendFile = (req, res, file) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new HttpError(404, 'Not found');
    }
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
    const headers = {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        etag
    };
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
};

const checkName = name => {
    if (!SAFE_NAME.test(name) || name.startsWith('.')) {
        throw new HttpError(400, `Bad name: ${name}`);
    }
    return name;
};

const downloads = new Map();

/** Path to the project's file, downloading it first if it is not cached yet. */
const projectFile = async id => {
    if (!Object.hasOwn(CORPUS, id)) throw new HttpError(404, `No project ${id}`);
    const {url} = CORPUS[id];
    const name = checkName(path.posix.basename(new URL(url).pathname));
    const sha256 = name.replace(/\..*$/, '');
    const file = path.join(PROJECT_CACHE, name);
    if (fs.existsSync(file)) return file;
    if (!downloads.has(file)) {
        downloads.set(file, (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new HttpError(502, `Downloading ${url}: HTTP ${res.status}`);
            const data = Buffer.from(await res.arrayBuffer());
            const actual = crypto.createHash('sha256').update(data).digest('hex');
            if (actual !== sha256) throw new HttpError(502, `Downloading ${url}: got SHA-256 ${actual}`);
            fs.mkdirSync(PROJECT_CACHE, {recursive: true});
            fs.writeFileSync(`${file}.tmp`, data);
            fs.renameSync(`${file}.tmp`, file);
        })().finally(() => downloads.delete(file)));
    }
    await downloads.get(file);
    return file;
};

const listProjects = () => Object.entries(CORPUS)
    .map(([id, {title, author}]) => {
        const recordingFile = path.join(RECORDINGS, `${id}.json`);
        let recording = null;
        if (fs.existsSync(recordingFile)) {
            const {frames, recordedAt} = JSON.parse(fs.readFileSync(recordingFile, 'utf8'));
            recording = {frames, recordedAt};
        }
        return {id, metadata: {title, author}, recording};
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'en', {numeric: true}));

const listBuilds = () => (fs.existsSync(BUILDS) ? fs.readdirSync(BUILDS) : [])
    .filter(name => fs.existsSync(path.join(BUILDS, name, 'build.json')))
    .map(name => JSON.parse(fs.readFileSync(path.join(BUILDS, name, 'build.json'), 'utf8')));

// A zip of a directory, built on request so it always matches the files. Deflate only, no
// directories entries, which is all Chrome's "Load unpacked" (after extracting) needs.
const zipDirectory = dir => {
    const files = fs.readdirSync(dir, {recursive: true})
        .filter(name => fs.statSync(path.join(dir, name)).isFile());
    const local = [];
    const central = [];
    let offset = 0;
    for (const name of files) {
        const data = fs.readFileSync(path.join(dir, name));
        const compressed = zlib.deflateRawSync(data, {level: 9});
        const nameBuffer = Buffer.from(`${path.basename(dir)}/${name.split(path.sep).join('/')}`);
        const crc = zlib.crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(8, 8);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressed.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBuffer.length, 26);
        local.push(header, nameBuffer, compressed);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(compressed.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(nameBuffer.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBuffer);
        offset += header.length + nameBuffer.length + compressed.length;
    }
    const centralSize = central.reduce((sum, b) => sum + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
};

const readBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
});

// The new recording is written next to the old one and renamed over it, so a failed save never
// leaves a half-written file behind.
const saveRecording = async (id, req) => {
    const recording = await readBody(req);
    if (JSON.parse(recording).project !== id) {
        throw new HttpError(400, 'Recording is for a different project');
    }
    const file = path.join(RECORDINGS, `${checkName(id)}.json`);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(`${file}.tmp`, recording);
    fs.renameSync(`${file}.tmp`, file);
};

//   GET  /api/queue                          counts, ETA, workers, recent batches
//   POST /api/queue/batches                  {label, jobs: [{url, meta, timeoutMs, device}], spec} -> {id}
//   GET  /api/queue/batches/<id>             the batch with every job and result
//   POST /api/queue/batches/<id>/cancel     {project?} -> {cancelled}; only that project's jobs if given
//   POST /api/queue/claim                    {worker, name, userAgent} -> {job, status}; waits for a job
//   POST /api/queue/jobs/<id>/heartbeat      {worker} -> {ok}; ok is false if the job was taken away
//   POST /api/queue/jobs/<id>/result         {worker, result}
//   POST /api/queue/jobs/<id>/fail           {worker, error}
//   POST /api/queue/jobs/<id>/trace?worker=  gzipped Chrome trace (Perfetto protobuf); GET downloads it,
//                                            as JSON with ?format=json (for DevTools)
//   POST /api/queue/jobs/<id>/sources?worker=  gzipped {url: source} of the compiled scripts; GET too
const handleQueue = async (req, res, [kind, id, action]) => {
    if (kind === 'jobs' && (action === 'trace' || action === 'sources')) {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const base = path.join(TRACES, String(Number(id)));
        const file = action === 'sources' ? `${base}.sources.json.gz` : `${base}.pftrace.gz`;
        if (req.method === 'GET') {
            if (!fs.existsSync(file)) throw new HttpError(404, `No ${action} for this job`);
            const download = action === 'trace' && params.get('format') === 'json' ?
                await traceAsJSON(file) :
                file;
            res.writeHead(200, {
                'content-type': 'application/gzip',
                'content-disposition': `attachment; filename="${path.basename(download).replace('.converted', '')}"`
            });
            fs.createReadStream(download).pipe(res);
            return;
        }
        const worker = params.get('worker');
        if (!queue.isRunning(Number(id), worker)) throw new HttpError(409, 'Not this worker\'s running job');
        fs.mkdirSync(TRACES, {recursive: true});
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(`${file}.tmp`);
            req.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            req.on('error', reject);
        });
        fs.renameSync(`${file}.tmp`, file);
        return sendJSON(res, {ok: true});
    }
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : null;
    if (!kind && req.method === 'GET') return sendJSON(res, queue.status());
    if (kind === 'batches' && !id && body) {
        if (!Array.isArray(body.jobs) || !body.jobs.length) throw new HttpError(400, 'No jobs');
        return sendJSON(res, {id: queue.submit(body.label || '', body.jobs, body.spec)});
    }
    if (kind === 'batches' && id && !action && req.method === 'GET') {
        const batch = queue.batch(Number(id));
        if (!batch) throw new HttpError(404, 'No such batch');
        return sendJSON(res, batch);
    }
    if (kind === 'batches' && action === 'cancel' && body) {
        const project = body.project === undefined ? null : String(body.project);
        return sendJSON(res, {ok: true, cancelled: queue.cancel(Number(id), project)});
    }
    if (kind === 'claim' && body) {
        queue.seen(body.worker, {name: body.name, userAgent: body.userAgent, tracing: !!body.tracing, readbackAltered: !!body.readbackAltered, job: null});
        const gone = new AbortController();
        res.on('close', () => gone.abort());
        const job = await queue.claim(body.worker, CLAIM_WAIT_MS, gone.signal);
        if (gone.signal.aborted && job) {
            queue.fail(job.id, body.worker, 'worker disconnected before receiving the job');
        }
        return sendJSON(res, {job, status: queue.status()});
    }
    if (kind === 'jobs' && body) {
        const jobId = Number(id);
        if (action === 'heartbeat') return sendJSON(res, {ok: queue.heartbeat(jobId, body.worker)});
        if (action === 'result') return sendJSON(res, {ok: queue.complete(jobId, body.worker, body.result)});
        if (action === 'fail') return sendJSON(res, {ok: queue.fail(jobId, body.worker, body.error)});
    }
    throw new HttpError(404, 'Not found');
};

const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (url.pathname === '/runner/extension.zip') {
        const zip = zipDirectory(path.join(ROOT, 'profiler-extension'));
        res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="pianola-profiler.zip"',
            'cache-control': 'no-store'
        });
        res.end(zip);
        return;
    }

    if (url.pathname === '/') {
        res.writeHead(302, {location: '/runner/'});
        res.end();
        return;
    }

    if (parts[0] === 'api') {
        const [, kind, id, rest] = parts;
        if (kind === 'builds' && !id) return sendJSON(res, listBuilds());
        if (kind === 'projects' && !id) return sendJSON(res, listProjects());
        if (kind === 'projects' && !rest) return sendFile(req, res, await projectFile(id));
        if (kind === 'recordings' && id && !rest) {
            if (req.method === 'PUT') {
                await saveRecording(id, req);
                return sendJSON(res, {ok: true});
            }
            return sendFile(req, res, path.join(RECORDINGS, `${checkName(id)}.json`));
        }
        if (kind === 'queue') return handleQueue(req, res, parts.slice(2));
        throw new HttpError(404, 'Not found');
    }

    for (const [prefix, dir] of Object.entries(STATIC)) {
        if (`${url.pathname}/` === prefix) {
            res.writeHead(302, {location: prefix});
            res.end();
            return;
        }
        if (url.pathname.startsWith(prefix)) {
            const rest = parts.slice(1).map(checkName);
            return sendFile(req, res, path.join(dir, ...(rest.length ? rest : ['index.html'])));
        }
    }
    throw new HttpError(404, 'Not found');
};

const server = http.createServer((req, res) => {
    // Cross-origin isolation, without which browsers coarsen performance.now() (to 100 µs in
    // Chrome, 1 ms in Firefox). Everything is served from here, so require-corp blocks nothing.
    // Browsers only honour it in a secure context: localhost or HTTPS, not plain http://<address>.
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-embedder-policy', 'require-corp');
    handle(req, res).catch(err => {
        if (!res.headersSent) {
            res.writeHead(err.status || 500, {'content-type': 'text/plain; charset=utf-8'});
        }
        res.end(err.status ? err.message : String(err.stack || err));
    });
});
server.listen(Number(values.port), values.host, () => {
    const host = values.host === '0.0.0.0' ? 'localhost' : values.host;
    console.log(`Painter: http://${host}:${values.port}/painter/ (recordings in ${RECORDINGS})`);
    console.log(`Workers: http://${host}:${values.port}/runner/`);
});
