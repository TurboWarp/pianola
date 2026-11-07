// Operator view of the job queue: refreshes every couple of seconds.

const $ = id => document.getElementById(id);

// Heartbeats are every 5 s but share the thread with the benchmark, so heavy frames can delay
// them. After this long the server gives the worker's job to someone else (its lease runs out).
const STALE_MS = 30000;

const formatDuration = ms => {
    if (ms === null || ms === undefined) return '?';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
};

const browserName = ua => {
    const match = ua && ua.match(/(Firefox|Edg|Chrome|Version)\/(\d+)/);
    if (!match) return ua || '';
    const browser = {Edg: 'Edge', Version: 'Safari'}[match[1]] || match[1];
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /CrOS/.test(ua) ? 'ChromeOS' :
        /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return `${browser} ${match[2]} ${os}`;
};

const row = (tbody, cells) => {
    const tr = tbody.insertRow();
    for (const cell of cells) {
        const td = tr.insertCell();
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell;
    }
    return tr;
};

const refresh = async () => {
    const status = await (await fetch('/api/queue')).json();
    const c = status.counts;
    $('summary').textContent = `${c.pending || 0} pending  ${c.running || 0} running  ${c.done || 0} done  ` +
        `${c.failed || 0} failed  eta ${formatDuration(status.etaMs)}  avg job ${formatDuration(status.avgJobMs)}  ` +
        `${status.workers.length} workers` + (status.stuck ? `  ${status.stuck} jobs no worker can run` : '');

    const now = Date.now();
    $('workers').replaceChildren();
    for (const worker of status.workers) {
        const flag = document.createElement('span');
        if (worker.readbackAltered) {
            flag.className = 'altered';
            flag.textContent = 'readback altered: pixel checks unreliable';
        }
        const tr = row($('workers'), [
            worker.id, worker.job || '', worker.done, worker.failed,
            `${formatDuration(now - worker.lastSeen)} ago`, browserName(worker.userAgent), flag
        ]);
        if (now - worker.lastSeen > STALE_MS) tr.className = 'stale';
    }

    $('batches').replaceChildren();
    for (const batch of status.batches) {
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.hidden = !(batch.pending || batch.running);
        cancel.addEventListener('click', async () => {
            await fetch(`/api/queue/batches/${batch.id}/cancel`, {method: 'POST'});
            refresh();
        });
        const finished = batch.done + batch.failed + batch.cancelled;
        row($('batches'), [
            batch.id, batch.label, `${Math.floor(finished * 100 / batch.total)}% of ${batch.total}`,
            batch.pending, batch.running, batch.done, batch.failed,
            batch.pending || batch.running ? (batch.etaMs === null ? 'no worker' : formatDuration(batch.etaMs)) : '',
            new Date(batch.created).toLocaleString(), cancel
        ]);
    }
};

const loop = async () => {
    try {
        await refresh();
    } catch (e) {
        $('summary').textContent = `server unreachable: ${e.message}`;
    }
    setTimeout(loop, 2000);
};
loop();
