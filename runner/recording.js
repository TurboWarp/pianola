// Loading builds and projects, and the recording file format shared by the painter and replays.
//
// Each project's recording is recordings/<project>.json, everything needed to rerun
// the session:
//   {
//     version: 1,
//     project: "<id>",
//     projectSha256: "...",            // of the project file it was recorded with
//     recordedAt: "<ISO date>",
//     frames: 1234,                    // frames run
//     passes: [1, 1, 3, ...],          // passes over the threads in each frame
//     inputs: [{frame, type, ...}]     // applied in order before stepping their frame
//   }
// There are no state hashes or stage snapshots: they differ between browsers, devices and GPUs
// (floating point details, rasterization), so replays only compare them between builds run in
// the same environment.

export const loadBuild = async name => {
    const base = `/builds/${encodeURIComponent(name)}`;
    const info = await (await fetch(`${base}/build.json`)).json();
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${base}/libs.js`;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Could not load build ${name}`));
        document.head.appendChild(script);
    });
    return {libs: window.RunnerLibs, info};
};

const fetchOk = async url => {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url}: ${res.status} ${res.statusText}`);
    }
    return res;
};

export const fetchProject = async id => (await fetchOk(`/api/projects/${encodeURIComponent(id)}`)).arrayBuffer();

export const fetchRecording = async id => {
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`);
    return res.status === 404 ? null : (await res.json());
};

/** Pretty JSON, except that passes take one line and each input one line, so long recordings remain readable. */
export const serializeRecording = recording => {
    const {passes, inputs, ...rest} = recording;
    const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
    const lines = inputs.map(input => `    ${JSON.stringify(input)}`).join(',\n');
    return `${head},\n  "passes": ${JSON.stringify(passes)},\n  "inputs": [\n${lines}\n  ]\n}\n`;
};

/** Replaces the project's recording. */
export const saveRecording = async recording => {
    const res = await fetch(`/api/recordings/${encodeURIComponent(recording.project)}`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: serializeRecording(recording)
    });
    if (!res.ok) {
        throw new Error(`Saving failed: ${res.status} ${await res.text()}`);
    }
};
