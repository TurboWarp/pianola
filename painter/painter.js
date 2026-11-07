// Records a human playing a project. Without ?project= this shows the project list.
//
// The project runs deterministically (see runner/runner.js), paced to its framerate.
// When the machine cannot keep up, the game slows down instead of skipping work, so the
// recording replays exactly either way. Restarting reloads the page, so every attempt starts
// from a fresh VM and fresh globals.

import {Runner} from '/runner/runner.js';
import {Stage} from '/runner/stage.js';
import {loadBuild, fetchProject, fetchRecording, saveRecording} from '/runner/recording.js';
import {detectAlteredReadback} from '/runner/readback.js';

const readbackProblem = detectAlteredReadback();
const READBACK_MESSAGE = 'Recordings made here would not replay, because projects that read pixels behave randomly. ' +
    'Paint in a browser without anti-fingerprinting, or turn it off for this site.';

const {RealDate} = window.RunnerDeterminism;
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Warp-mode scripts that never finish would freeze the page; fail sooner than the runner's default.
const WARP_LIMIT_MS = 15000;

const formatSeconds = ms => `${(ms / 1000).toFixed(2)} s`;

const showPicker = async () => {
    $('picker').hidden = false;
    if (readbackProblem) {
        $('picker-banned').hidden = false;
        $('picker-banned').textContent = `Painting is disabled: ${readbackProblem}. ${READBACK_MESSAGE}`;
    }
    const [builds, projects] = await Promise.all([
        fetch('/api/builds').then(r => r.json()),
        fetch('/api/projects').then(r => r.json())
    ]);

    const buildSelect = $('picker-build');
    for (const build of builds) {
        const option = new Option(`${build.name} (${(build.vm.commit || build.vm.dir).slice(0, 10)}${build.vm.dirty ? ', dirty' : ''})`, build.name);
        buildSelect.add(option);
    }
    buildSelect.value = localStorage.getItem('painter-build') || (builds[0] && builds[0].name) || '';
    buildSelect.addEventListener('change', () => localStorage.setItem('painter-build', buildSelect.value));
    if (!builds.length) {
        $('picker-build-hint').textContent = 'No builds. Run: npm run build -- --name <name> --vm <path to scratch-vm>';
    }

    const tbody = $('picker-projects');
    for (const project of projects) {
        const row = tbody.insertRow();
        row.insertCell().textContent = project.id;
        row.insertCell().textContent = project.metadata.title ?
            `${project.metadata.title} by ${project.metadata.author}` :
            '';
        row.insertCell().textContent = project.recording ?
            `${project.recording.frames} frames, ${project.recording.recordedAt.slice(0, 10)}` :
            '';

        const paint = document.createElement('button');
        paint.textContent = project.recording ? 'Redo' : 'Paint';
        paint.addEventListener('click', () => {
            location.search = new URLSearchParams({project: project.id, build: buildSelect.value}).toString();
        });
        row.insertCell().appendChild(paint);
    }
};

// The project page has the instructions and notes, which are not in the corpus.
const showProjectInfo = (id, metadata) => {
    $('title').textContent = metadata.title;
    const link = document.createElement('a');
    link.href = `https://scratch.mit.edu/projects/${encodeURIComponent(id)}/`;
    link.target = '_blank';
    link.textContent = `by ${metadata.author}`;
    $('byline').replaceChildren(link);
};

const showSession = async () => {
    const projectId = params.get('project');
    const buildName = params.get('build');
    $('session').hidden = false;
    $('title').textContent = projectId;
    document.title = `painter: ${projectId}`;
    fetch('/api/projects').then(r => r.json()).then(projects => {
        const project = projects.find(p => p.id === projectId);
        if (project && project.metadata.title) {
            showProjectInfo(projectId, project.metadata);
            document.title = `painter: ${project.metadata.title}`;
        }
    });

    const target = $('target');
    target.value = localStorage.getItem('painter-target-s') || 5;
    target.addEventListener('change', () => localStorage.setItem('painter-target-s', target.value));
    const autoStop = $('auto-stop');
    autoStop.checked = localStorage.getItem('painter-auto-stop') !== 'false';
    autoStop.addEventListener('change', () => {
        autoStop.blur();
        localStorage.setItem('painter-auto-stop', autoStop.checked);
    });

    // Clicked buttons keep focus, which would swallow keys meant for the project.
    document.addEventListener('click', e => {
        if (e.target instanceof HTMLButtonElement) e.target.blur();
    });

    let state = 'loading';
    const setState = newState => {
        state = newState;
        $('start').hidden = state !== 'ready';
        $('pause').hidden = state !== 'recording' && state !== 'paused';
        $('pause').textContent = state === 'paused' ? 'Resume' : 'Pause';
        $('finish').hidden = state !== 'recording' && state !== 'paused';
        $('save').hidden = state !== 'finished';
        $('green-flag').disabled = state !== 'recording' && state !== 'paused';
        $('stop-sign').disabled = $('green-flag').disabled;
        $('turbo').disabled = state !== 'ready' && state !== 'recording' && state !== 'paused';
        const labels = {
            loading: 'Loading',
            ready: 'Ready',
            recording: 'Recording',
            paused: 'Paused',
            finished: 'Finished',
            saved: 'Saved',
            error: 'Error',
            banned: 'Painting disabled'
        };
        $('status').textContent = labels[state];
        $('status').dataset.state = state;
    };
    setState('loading');
    if (readbackProblem) {
        $('errors').hidden = false;
        const li = document.createElement('li');
        li.textContent = `${readbackProblem}. ${READBACK_MESSAGE}`;
        $('error-list').appendChild(li);
        setState('banned');
        return;
    }

    const showError = message => {
        $('errors').hidden = false;
        const li = document.createElement('li');
        li.textContent = message;
        $('error-list').appendChild(li);
    };

    let runner;
    const stage = new Stage($('stage'), {
        interactive: true,
        onInput: input => {
            if (state === 'recording' || state === 'paused') {
                runner.input(input);
            }
        }
    });

    const [{libs, info: buildInfo}, projectData, existing] = await Promise.all([
        loadBuild(buildName),
        fetchProject(projectId),
        fetchRecording(projectId)
    ]);
    runner = new Runner({libs, canvas: stage.canvas, warpLimitMs: WARP_LIMIT_MS});
    stage.attach(runner);
    await runner.load(projectData);
    // For debugging from the console.
    window.runner = runner;

    $('stat-build').textContent = `${buildInfo.name} ${(buildInfo.vm.commit || '').slice(0, 10)}${buildInfo.vm.dirty ? ' (dirty)' : ''}`;
    $('stat-framerate').textContent = `${runner.fps} fps`;

    // Play speed only changes how many frames run per real second; every frame is the same
    // as at 1x, so it is not recorded.
    const speed = $('speed');
    const speedLabel = () => {
        $('speed-value').textContent = `${speed.value}x`;
    };
    speed.value = 1;
    speedLabel();

    // Frames are due at the project's framerate times the speed. Pacing is measured from an
    // anchor that is reset whenever the speed changes, after pausing, or when falling behind.
    const stepTimes = [];
    let anchorTime = 0;
    let anchorFrame = 0;
    let shownErrors = 0;
    const resetPacing = () => {
        // Back by one frame so that the next animation frame steps right away.
        anchorTime = performance.now() - (runner.frameInterval / speed.value);
        anchorFrame = runner.frame;
    };
    speed.addEventListener('input', () => {
        speedLabel();
        resetPacing();
    });
    // A focused slider would take arrow keys meant for the project.
    speed.addEventListener('change', () => speed.blur());

    // Frames take a turn of the event loop each (see Runner.step()), so a tick can still be
    // running when the next animation frame comes.
    let ticking = false;
    const tick = async now => {
        requestAnimationFrame(tick);
        if (state !== 'recording' || ticking) return;
        ticking = true;
        // A little slack for animation frame jitter, e.g. 30 fps on a 60 Hz display.
        const due = Math.floor((now - anchorTime + 2) * speed.value / runner.frameInterval) - (runner.frame - anchorFrame);
        // Leave time to present each animation frame even when many frames are due.
        const deadline = performance.now() + 25;
        let stepped = 0;
        while (state === 'recording' && stepped < due && performance.now() < deadline) {
            try {
                await runner.step();
            } catch (e) {
                runner.errors.push(String(e && e.message || e));
                setState('error');
            }
            stepped++;
            stepTimes.push(now);
            if (state === 'recording' && autoStop.checked && runner.executeMs + runner.drawMs >= target.value * 1000) {
                finish();
            }
        }
        // When behind, carry on from here rather than trying to catch up.
        if (due - stepped > 1) {
            resetPacing();
        }
        while (stepTimes[0] < now - 1000) stepTimes.shift();
        updateStats();
        ticking = false;
    };

    const updateStats = () => {
        const cpuMs = runner.executeMs + runner.drawMs;
        // Scaled to the target, or to the total once past it.
        const scale = 100 / Math.max(cpuMs, target.value * 1000);
        $('stat-cpu').textContent = formatSeconds(cpuMs);
        $('bar-execute').style.width = `${runner.executeMs * scale}%`;
        $('bar-draw').style.width = `${runner.drawMs * scale}%`;
        $('stat-execute').textContent = formatSeconds(runner.executeMs);
        $('stat-draw').textContent = formatSeconds(runner.drawMs);
        $('stat-frame').textContent = `${runner.frame} (${formatSeconds(runner.frame * runner.frameInterval)} project time)`;
        $('stat-speed').textContent = `${stepTimes.length} / ${runner.fps * speed.value} fps`;
        $('stat-inputs').textContent = runner.inputs.length;
        while (shownErrors < runner.errors.length) {
            showError(runner.errors[shownErrors++]);
        }
    };

    $('start').addEventListener('click', () => {
        if ($('turbo').checked) {
            runner.input({type: 'turbo', on: true});
        }
        runner.input({type: 'greenFlag'});
        resetPacing();
        setState('recording');
    });
    $('pause').addEventListener('click', () => {
        setState(state === 'paused' ? 'recording' : 'paused');
        resetPacing();
    });
    $('green-flag').addEventListener('click', () => runner.input({type: 'greenFlag'}));
    $('stop-sign').addEventListener('click', () => runner.input({type: 'stop'}));
    // Browsers can restore a checkbox's state on reload.
    runner.fillFrames = $('fill-frames').checked;
    $('fill-frames').addEventListener('change', e => {
        e.target.blur();
        runner.fillFrames = e.target.checked;
    });
    // Before starting this only sets what the first frame uses; afterwards toggling it is an input.
    $('turbo').addEventListener('change', e => {
        e.target.blur();
        if (state === 'recording' || state === 'paused') {
            runner.input({type: 'turbo', on: e.target.checked});
        }
    });

    const finish = () => {
        setState('finished');
        updateStats();
    };
    $('finish').addEventListener('click', finish);

    $('save').addEventListener('click', async () => {
        if (existing && !confirm(`Replace the existing recording (${existing.frames} frames, ${existing.recordedAt})?`)) {
            return;
        }
        const recording = {
            version: 1,
            project: projectId,
            projectSha256: runner.projectSha256,
            recordedAt: new RealDate().toISOString(),
            frames: runner.frame,
            passes: runner.passes,
            inputs: runner.inputs
        };
        try {
            await saveRecording(recording);
            setState('saved');
        } catch (e) {
            showError(e.message);
        }
    });

    $('restart').addEventListener('click', () => {
        if ((state === 'recording' || state === 'paused' || state === 'finished') && !confirm('Throw this recording away and start over?')) {
            return;
        }
        state = 'restarting';
        location.reload();
    });

    // Do not lose a recording by accidentally closing or reloading the tab.
    window.addEventListener('beforeunload', e => {
        if (state === 'recording' || state === 'paused' || state === 'finished') {
            e.preventDefault();
        }
    });

    setState('ready');
    updateStats();
    requestAnimationFrame(tick);
};

(params.has('project') ? showSession() : showPicker()).catch(e => {
    document.body.textContent = `Error: ${e.stack || e}`;
});
