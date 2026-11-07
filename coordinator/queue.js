// A persistent job queue for remote workers (runner/worker.html).
//
// A job is generic: a page URL to open in an iframe, which posts a result back to the worker.
// Workers claim jobs with a lease and renew it with heartbeats. A job whose lease runs out
// (the worker closed, hung, or lost its connection) goes back to the queue, up to MAX_ATTEMPTS.

import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const LEASE_MS = 30000;
const MAX_ATTEMPTS = 3;
// A worker that has not been heard from for this long is no longer listed.
const WORKER_GONE_MS = 60000;
// How many of the most recent finished jobs job duration estimates are based on.
const HISTORY_JOBS = 5000;

/** A worker's id is its device name and a random suffix (runner/worker.js). */
const workerName = id => id.replace(/-[a-z0-9]+$/, '');

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export class Queue {
    constructor (file) {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        this.db = new DatabaseSync(file);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS batches (
                id INTEGER PRIMARY KEY,
                label TEXT,
                created INTEGER NOT NULL,
                spec TEXT
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY,
                batch INTEGER NOT NULL REFERENCES batches(id),
                url TEXT NOT NULL,
                -- Free-form data for whoever submitted the batch, e.g. which build and project.
                meta TEXT,
                timeout_ms INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                worker TEXT,
                lease_until INTEGER,
                started INTEGER,
                finished INTEGER,
                result TEXT,
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);
        `);
        // Added later: only workers with this device name may claim the job.
        if (!this.db.prepare('SELECT 1 FROM pragma_table_info(\'jobs\') WHERE name = \'device\'').get()) {
            this.db.exec('ALTER TABLE jobs ADD COLUMN device TEXT');
        }
        // Jobs that were running when the server stopped are lost with their workers.
        this.db.exec(`UPDATE jobs SET status = 'pending', worker = NULL, lease_until = NULL WHERE status = 'running'`);
        this.workers = new Map();
        this.waiters = [];
    }

    /**
     * @param {string} label
     * @param {Array<{url: string, meta?: object, timeoutMs?: number, device?: string}>} jobs Run in
     *   this order. With a device, only workers of that name run the job.
     * @param {object} [spec] What the batch was made from, for reference.
     */
    submit (label, jobs, spec = null) {
        const {lastInsertRowid: batch} = this.db.prepare('INSERT INTO batches (label, created, spec) VALUES (?, ?, ?)')
            .run(label, Date.now(), JSON.stringify(spec));
        const insert = this.db.prepare('INSERT INTO jobs (batch, url, meta, timeout_ms, device) VALUES (?, ?, ?, ?, ?)');
        this.db.exec('BEGIN');
        for (const job of jobs) {
            insert.run(batch, job.url, JSON.stringify(job.meta || null), job.timeoutMs || 10 * 60000, job.device || null);
        }
        this.db.exec('COMMIT');
        this._wakeWaiters();
        return Number(batch);
    }

    /** Record that a worker exists and what it is doing; returns the worker. */
    seen (id, info = {}) {
        const worker = this.workers.get(id) || {id, done: 0, failed: 0, job: null, since: Date.now()};
        Object.assign(worker, info, {lastSeen: Date.now()});
        this.workers.set(id, worker);
        return worker;
    }

    _expireLeases () {
        const now = Date.now();
        // A worker waiting for a job has a request open, so it is still there.
        for (const waiter of this.waiters) {
            const worker = this.workers.get(waiter.workerId);
            if (worker) worker.lastSeen = now;
        }
        this.db.prepare(`UPDATE jobs SET status = 'failed', error = 'lease expired ' || attempts || ' times', worker = NULL
            WHERE status = 'running' AND lease_until < ? AND attempts >= ?`).run(now, MAX_ATTEMPTS);
        this.db.prepare(`UPDATE jobs SET status = 'pending', worker = NULL, lease_until = NULL
            WHERE status = 'running' AND lease_until < ?`).run(now);
        for (const [id, worker] of this.workers) {
            if (now - worker.lastSeen > WORKER_GONE_MS) this.workers.delete(id);
        }
    }

    _tryClaim (workerId) {
        this._expireLeases();
        const worker = this.workers.get(workerId);
        // Jobs that want a trace need a worker with the tracer extension.
        const job = this.db.prepare(`SELECT * FROM jobs WHERE status = 'pending' AND (device IS NULL OR device = ?)
            AND (coalesce(json_extract(meta, '$.trace'), 0) = 0 OR ?)
            ORDER BY id LIMIT 1`).get(worker ? worker.name || null : null, worker && worker.tracing ? 1 : 0);
        if (!job) return null;
        const now = Date.now();
        this.db.prepare(`UPDATE jobs SET status = 'running', worker = ?, attempts = attempts + 1, lease_until = ?, started = ?
            WHERE id = ?`).run(workerId, now + LEASE_MS, now, job.id);
        this.seen(workerId, {job: job.id});
        return {id: job.id, batch: job.batch, url: job.url, meta: JSON.parse(job.meta), timeoutMs: job.timeout_ms, leaseMs: LEASE_MS};
    }

    /**
     * Resolves with a job, or null if none arrived within waitMs or the signal aborted (the
     * worker went away, so it must not be handed a job).
     */
    claim (workerId, waitMs, signal) {
        const job = this._tryClaim(workerId);
        if (job || waitMs <= 0) return Promise.resolve(job);
        return new Promise(resolve => {
            const waiter = {workerId, resolve};
            const stop = () => {
                clearTimeout(waiter.timer);
                this.waiters = this.waiters.filter(w => w !== waiter);
                resolve(null);
            };
            waiter.timer = setTimeout(stop, waitMs);
            if (signal) signal.addEventListener('abort', stop, {once: true});
            this.waiters.push(waiter);
        });
    }

    _wakeWaiters () {
        // Waiters may be for different devices, so each one gets a chance.
        for (const waiter of [...this.waiters]) {
            const job = this._tryClaim(waiter.workerId);
            if (!job) continue;
            this.waiters = this.waiters.filter(w => w !== waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(job);
        }
    }

    _ownedRunning (jobId, workerId) {
        const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
        return job && job.status === 'running' && job.worker === workerId ? job : null;
    }

    /** Whether the job is running on this worker, e.g. to accept an upload for it. */
    isRunning (jobId, workerId) {
        return !!this._ownedRunning(jobId, workerId);
    }

    /** @returns {boolean} False if the job is no longer this worker's (its lease ran out). */
    heartbeat (jobId, workerId) {
        this.seen(workerId);
        if (!this._ownedRunning(jobId, workerId)) return false;
        this.db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run(Date.now() + LEASE_MS, jobId);
        return true;
    }

    complete (jobId, workerId, result) {
        const worker = this.seen(workerId, {job: null});
        if (!this._ownedRunning(jobId, workerId)) return false;
        this.db.prepare(`UPDATE jobs SET status = 'done', result = ?, finished = ?, lease_until = NULL WHERE id = ?`)
            .run(JSON.stringify(result), Date.now(), jobId);
        worker.done++;
        return true;
    }

    /** A failed attempt; the job is retried until MAX_ATTEMPTS. */
    fail (jobId, workerId, error) {
        const worker = this.seen(workerId, {job: null});
        const job = this._ownedRunning(jobId, workerId);
        if (!job) return false;
        const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        this.db.prepare(`UPDATE jobs SET status = ?, error = ?, worker = NULL, lease_until = NULL WHERE id = ?`)
            .run(status, String(error), jobId);
        worker.failed++;
        this._wakeWaiters();
        return true;
    }

    /**
     * Remove a batch's unfinished jobs from the queue, or only those of one project (e.g. one that
     * crashes a device). A running job's worker drops it at its next heartbeat.
     * @returns {number} How many jobs were cancelled.
     */
    cancel (batchId, project = null) {
        return Number(this.db.prepare(`UPDATE jobs SET status = 'cancelled', worker = NULL, lease_until = NULL
            WHERE batch = ? AND status IN ('pending', 'running')
            AND (? IS NULL OR json_extract(meta, '$.project') = ?)`).run(batchId, project, project).changes);
    }

    status () {
        this._expireLeases();
        const counts = Object.fromEntries(this.db.prepare(`SELECT status, COUNT(*) n FROM jobs
            WHERE batch IN (SELECT DISTINCT batch FROM jobs WHERE status IN ('pending', 'running'))
            GROUP BY status`).all().map(r => [r.status, r.n]));
        const recent = this.db.prepare(`SELECT AVG(finished - started) ms FROM
            (SELECT finished, started FROM jobs WHERE status = 'done' ORDER BY finished DESC LIMIT 50)`).get();
        const workers = [...this.workers.values()];
        const forecast = this._forecast();
        const batches = this.db.prepare(`SELECT b.id, b.label, b.created,
                SUM(j.status = 'pending') pending, SUM(j.status = 'running') running,
                SUM(j.status = 'done') done, SUM(j.status = 'failed') failed, SUM(j.status = 'cancelled') cancelled,
                COUNT(*) total
            FROM batches b JOIN jobs j ON j.batch = b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 20`).all();
        for (const batch of batches) {
            // Null when no worker here can run some of its jobs; absent when there is nothing to estimate from.
            if ((batch.pending || batch.running) && forecast.etaMs !== null) batch.etaMs = forecast.batches.get(batch.id) ?? null;
        }
        return {counts, etaMs: forecast.etaMs, stuck: forecast.stuck, avgJobMs: recent.ms, workers, batches};
    }

    /**
     * Estimates how long a job takes on a device from earlier runs of the same URL (build and
     * project): on that device if it has run it, otherwise its typical cost scaled by how fast the
     * device is compared to the others, otherwise the device's recent average.
     * @returns {((url: string, device: string) => number)|null} Null before any job has finished.
     */
    _durationEstimator () {
        const rows = this.db.prepare(`SELECT url, worker, finished - started ms FROM jobs
            WHERE status = 'done' AND worker IS NOT NULL ORDER BY finished DESC LIMIT ?`).all(HISTORY_JOBS);
        if (!rows.length) return null;
        const runs = new Map(); // url -> device -> durations
        const deviceRuns = new Map(); // device -> durations, most recent first
        for (const {url, worker, ms} of rows) {
            const device = workerName(worker);
            if (!runs.has(url)) runs.set(url, new Map());
            const devices = runs.get(url);
            if (!devices.has(device)) devices.set(device, []);
            devices.get(device).push(ms);
            if (!deviceRuns.has(device)) deviceRuns.set(device, []);
            deviceRuns.get(device).push(ms);
        }
        // A device's speed factor is its median ratio to the mean over devices, among URLs that
        // more than one device has run. A URL's cost is then its mean duration with factors removed.
        const shared = [...runs].filter(([, devices]) => devices.size > 1);
        const factors = new Map();
        for (const device of deviceRuns.keys()) {
            const ratios = shared.filter(([, devices]) => devices.has(device))
                .map(([, devices]) => mean(devices.get(device)) / mean([...devices.values()].map(mean)));
            if (ratios.length) factors.set(device, median(ratios));
        }
        const costs = new Map();
        for (const [url, devices] of runs) {
            const normalized = [...devices].filter(([device]) => factors.has(device))
                .map(([device, durations]) => mean(durations) / factors.get(device));
            if (normalized.length) costs.set(url, mean(normalized));
        }
        const fallback = mean(rows.slice(0, 50).map(r => r.ms));
        return (url, device) => {
            const own = runs.get(url)?.get(device);
            if (own) return mean(own);
            if (costs.has(url) && factors.has(device)) return costs.get(url) * factors.get(device);
            const recentOnDevice = deviceRuns.get(device);
            return recentOnDevice ? mean(recentOnDevice.slice(0, 50)) : fallback;
        };
    }

    /**
     * Plays the queue forward the way workers claim from it: whenever a worker is free, it takes the
     * lowest pending job it is allowed to run. Workers that are around now are assumed to stay.
     * @returns {{etaMs: number|null, batches: Map<number, number>, stuck: number}} When everything
     *   and each batch is expected to be done, and how many jobs no current worker can run.
     */
    _forecast () {
        const now = Date.now();
        const estimate = this._durationEstimator();
        const batches = new Map();
        if (!estimate) return {etaMs: null, batches, stuck: 0};
        let etaMs = 0;
        const finishAt = (batch, at) => {
            batches.set(batch, Math.max(batches.get(batch) ?? 0, at - now));
            etaMs = Math.max(etaMs, at - now);
        };
        const slots = [...this.workers.values()].map(worker => ({worker, name: worker.name || workerName(worker.id), at: now}));
        for (const job of this.db.prepare(`SELECT batch, url, worker, started FROM jobs WHERE status = 'running'`).all()) {
            const slot = slots.find(s => s.worker.id === job.worker);
            const ms = estimate(job.url, workerName(job.worker));
            const at = now + Math.max(0, ms - (now - job.started));
            if (slot) slot.at = at;
            finishAt(job.batch, at);
        }

        // Pending jobs, by who may run them, each in claim order.
        const queues = new Map();
        const pending = this.db.prepare(`SELECT id, batch, url, device, coalesce(json_extract(meta, '$.trace'), 0) trace
            FROM jobs WHERE status = 'pending' ORDER BY id`).all();
        for (const job of pending) {
            const key = `${job.device}\n${job.trace}`;
            if (!queues.has(key)) queues.set(key, {device: job.device, trace: job.trace, jobs: [], next: 0});
            queues.get(key).jobs.push(job);
        }
        let assigned = 0;
        while (slots.length) {
            const slot = slots.reduce((a, b) => (b.at < a.at ? b : a));
            let best = null;
            for (const queue of queues.values()) {
                if (queue.next >= queue.jobs.length) continue;
                if (queue.device !== null && queue.device !== slot.name) continue;
                if (queue.trace && !slot.worker.tracing) continue;
                if (!best || queue.jobs[queue.next].id < best.jobs[best.next].id) best = queue;
            }
            if (!best) {
                slots.splice(slots.indexOf(slot), 1);
                continue;
            }
            const job = best.jobs[best.next++];
            slot.at += estimate(job.url, slot.name);
            finishAt(job.batch, slot.at);
            assigned++;
        }
        // Batches with jobs that nobody here can run are not going to finish.
        for (const queue of queues.values()) {
            for (const job of queue.jobs.slice(queue.next)) batches.set(job.batch, null);
        }
        return {etaMs, batches, stuck: pending.length - assigned};
    }

    batch (batchId) {
        const batch = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
        if (!batch) return null;
        const jobs = this.db.prepare('SELECT * FROM jobs WHERE batch = ? ORDER BY id').all(batchId).map(job => ({
            id: job.id,
            url: job.url,
            meta: JSON.parse(job.meta),
            status: job.status,
            attempts: job.attempts,
            worker: job.worker,
            started: job.started,
            finished: job.finished,
            result: job.result ? JSON.parse(job.result) : null,
            error: job.error
        }));
        return {id: batch.id, label: batch.label, created: batch.created, spec: JSON.parse(batch.spec), jobs};
    }
}
