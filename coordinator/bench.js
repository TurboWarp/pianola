// Submits a benchmark to the job queue, waits for the workers, and summarizes.
//
//   node coordinator/bench.js --build <name> [--build <name>...] [--project <id>...] [--repeat 1]
//                        [--device <name>] [--trace] [--label <text>] [--server http://localhost:8100] [--no-wait]
//   node coordinator/bench.js --batch <id>       summarize (and wait for) an existing batch
//   node coordinator/bench.js --cancel <id> [--project <id>...]   cancel a batch, or only some projects
//
// Without --project, every project with a recording is used. With --device, only workers with that
// name run the jobs. With --trace, each job also records a Chrome trace, on workers with the tracer
// extension (profiler-extension/); tracing slows things down, so traced timings are not comparable. Each project's builds run back to
// back. Which build goes first rotates from project to project and from repeat to repeat, so even a
// single repeat runs each build first equally often, and whatever favours going first or second
// (warm caches, clock speed) evens out across the batch, and for each project over a multiple of
// as many repeats as there are builds.
//
// State hashes and stage snapshots differ between browsers and devices, so instead of checking
// them against the recording, each replay is compared with the first build's replays of that
// project in the same environment (device name, browser and GPU). A mismatch means the builds
// behave or draw differently, or the project does not replay deterministically there; repeats of
// the first build show which.

import {parseArgs} from 'node:util';

const {values} = parseArgs({
    options: {
        build: {type: 'string', multiple: true, default: []},
        project: {type: 'string', multiple: true, default: []},
        repeat: {type: 'string', default: '1'},
        label: {type: 'string'},
        server: {type: 'string', default: 'http://localhost:8100'},
        batch: {type: 'string'},
        cancel: {type: 'string'},
        device: {type: 'string'},
        trace: {type: 'boolean', default: false},
        'no-wait': {type: 'boolean', default: false}
    }
});
const server = values.server.replace(/\/$/, '');

const api = async (path, body) => {
    const res = await fetch(`${server}${path}`, body ? {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
    } : {});
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
};

const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** A worker's id is its device name and a random suffix (runner/worker.js). */
const environment = job => `${(job.worker || '?').replace(/-[a-z0-9]+$/, '')} | ${job.result.userAgent} | ${job.result.gpu}`;

/** How two replays first differ, or null if they do not. */
const compareReplays = (a, b) => {
    const longer = a.checks.hashes.length >= b.checks.hashes.length ? a.checks.hashes : b.checks.hashes;
    const index = longer.findIndex((_, i) => a.checks.hashes[i] !== b.checks.hashes[i]);
    const stateFrame = index !== -1 ? (index + 1) * a.checks.interval :
        a.checks.final.hash !== b.checks.final.hash ? a.checks.final.frame : Infinity;
    const stageFrame = Math.min(...Object.keys({...a.snapshots, ...b.snapshots})
        .filter(frame => a.snapshots[frame] !== b.snapshots[frame]).map(Number));
    if (stateFrame === Infinity && stageFrame === Infinity) return null;
    return stateFrame <= stageFrame ? `states differ from frame ${stateFrame}` : `stage differs at frame ${stageFrame} (states do not)`;
};

const submit = async () => {
    const builds = values.build;
    if (!builds.length) throw new Error('--build is required');
    const known = new Set((await api('/api/builds')).map(b => b.name));
    for (const build of builds) {
        if (!known.has(build)) throw new Error(`Unknown build ${build}`);
    }
    let projects = values.project;
    if (!projects.length) {
        projects = (await api('/api/projects')).filter(p => p.recording).map(p => p.id);
    }
    if (!projects.length) throw new Error('No projects with recordings');

    const repeats = Number(values.repeat);
    const jobs = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
        for (const [index, project] of projects.entries()) {
            const first = (repeat + index) % builds.length;
            const order = [...builds.slice(first), ...builds.slice(0, first)];
            for (const build of order) {
                const query = new URLSearchParams({build, project, ...(values.trace ? {trace: ''} : {})});
                jobs.push({url: `/runner/replay.html?${query}`, meta: {project, build, repeat, ...(values.trace ? {trace: true} : {})}, device: values.device});
            }
        }
    }
    const label = values.label ||
        `${builds.join(' vs ')}, ${projects.length} projects x${repeats}${values.device ? ` on ${values.device}` : ''}${values.trace ? ', traced' : ''}`;
    const {id} = await api('/api/queue/batches', {label, jobs, spec: {builds, projects, repeats}});
    console.log(`Submitted batch ${id}: ${jobs.length} jobs (${label})`);
    return id;
};

const waitFor = async id => {
    for (;;) {
        const batch = await api(`/api/queue/batches/${id}`);
        const count = status => batch.jobs.filter(j => j.status === status).length;
        const open = count('pending') + count('running');
        if (process.stdout.isTTY) {
            const {batches, workers} = await api('/api/queue');
            const {etaMs} = batches.find(b => b.id === batch.id) || {};
            const eta = etaMs === undefined ? '?' : etaMs === null ? 'never (no worker can run its jobs)' : `${Math.round(etaMs / 1000)}s`;
            process.stdout.write(`\r${count('done')} done, ${count('running')} running, ${count('pending')} pending, ` +
                `${count('failed')} failed, ${workers.length} workers, eta ${eta}   `);
        }
        if (!open) {
            if (process.stdout.isTTY) process.stdout.write('\n');
            return batch;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
};

const summarize = batch => {
    const done = batch.jobs.filter(j => j.status === 'done' && j.meta);
    const builds = (batch.spec && batch.spec.builds) || [...new Set(done.map(j => j.meta.build))];
    const projects = [...new Set(batch.jobs.map(j => j.meta && j.meta.project))].filter(Boolean);

    const rows = [];
    const ratios = [];
    const mismatches = [];
    const uncompared = [];
    for (const project of projects) {
        const jobs = done.filter(j => j.meta.project === project && j.result.checks && j.result.snapshots);
        // The reference for each environment is its first replay of the first build.
        const references = new Map();
        for (const job of jobs) {
            if (job.meta.build === builds[0] && !references.has(environment(job))) references.set(environment(job), job);
        }
        const mismatched = new Set();
        let compared = false;
        for (const job of jobs) {
            const reference = references.get(environment(job));
            if (!reference || reference === job) continue;
            if (job.meta.build !== builds[0]) compared = true;
            const mismatch = compareReplays(reference.result, job.result);
            if (!mismatch) continue;
            mismatched.add(job);
            const a = reference.result.checks.final.targets;
            const b = job.result.checks.final.targets;
            const targets = Object.keys({...a, ...b}).filter(name => a[name] !== b[name]);
            mismatches.push(`${project} ${job.meta.build} (repeat ${job.meta.repeat}) vs ${builds[0]} (repeat ${reference.meta.repeat}) ` +
                `on ${environment(job)}: ${mismatch}` +
                (targets.length ? `, at the end in ${targets.join(', ')}` : ''));
        }
        if (builds.length > 1 && jobs.length && !compared) uncompared.push(project);

        const cells = [project];
        const medians = builds.map(build => {
            const buildJobs = done.filter(j => j.meta.project === project && j.meta.build === build);
            if (!buildJobs.length) {
                cells.push('-');
                return null;
            }
            const ms = median(buildJobs.map(j => j.result.msPerFrame));
            const differing = buildJobs.filter(j => mismatched.has(j)).length;
            cells.push(`${ms.toFixed(2)} (n=${buildJobs.length}${differing ? `, ${differing} MISMATCH` : ''})`);
            return ms;
        });
        if (builds.length > 1 && medians[0] && medians[1]) {
            const ratio = medians[1] / medians[0];
            ratios.push(ratio);
            cells.push(`${((ratio - 1) * 100).toFixed(1)}%`);
        }
        rows.push(cells);
    }

    const header = ['project', ...builds.map(b => `${b} ms/frame`), ...(builds.length > 1 ? [`${builds[1]} vs ${builds[0]}`] : [])];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').length)));
    const line = cells => cells.map((c, i) => String(c || '').padEnd(widths[i])).join('  ');
    console.log(`\nBatch ${batch.id}: ${batch.label}`);
    console.log(line(header));
    for (const r of rows) console.log(line(r));
    if (ratios.length) {
        const geomean = Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length);
        console.log(`\ngeomean ${builds[1]} vs ${builds[0]}: ${((geomean - 1) * 100).toFixed(1)}%`);
    }

    if (mismatches.length) console.log(`\nmismatches:\n  ${mismatches.join('\n  ')}`);
    if (uncompared.length) {
        console.log(`\nstates not compared (no environment ran both ${builds[0]} and another build): ${uncompared.join(', ')}`);
    }

    const devices = [...new Set(done.map(j => `${environment(j)}${j.result.crossOriginIsolated ? '' : ' (not cross-origin isolated: coarse timer)'}`))];
    if (devices.length) console.log(`\nran on:\n  ${devices.join('\n  ')}`);
    const traced = done.filter(j => j.result.trace);
    if (traced.length) {
        console.log('\ntraces (open in https://ui.perfetto.dev; add ?format=json for the DevTools Performance panel):');
        for (const job of traced) {
            console.log(`  ${job.meta.project} ${job.meta.build}: ${server}/api/queue/jobs/${job.id}/trace (${(job.result.trace.compressedBytes / 1e6).toFixed(1)} MB)`);
        }
    }
    for (const job of done.filter(j => j.result.traceError)) {
        console.log(`  ${job.meta.project} ${job.meta.build}: trace failed: ${job.result.traceError}`);
    }
    const failed = batch.jobs.filter(j => j.status === 'failed');
    for (const job of failed) {
        console.log(`failed job ${job.id} ${JSON.stringify(job.meta)}: ${(job.error || '').split('\n')[0]}`);
    }
};

if (values.cancel) {
    for (const project of values.project.length ? values.project : [undefined]) {
        const {cancelled} = await api(`/api/queue/batches/${Number(values.cancel)}/cancel`, {project});
        console.log(`Cancelled ${cancelled} jobs of batch ${values.cancel}${project ? ` for project ${project}` : ''}`);
    }
    process.exit(0);
}
const id = values.batch ? Number(values.batch) : await submit();
if (!values['no-wait']) {
    summarize(await waitFor(id));
}
