// Runs a project one frame at a time, deterministically. Everything that reaches the VM
// from outside (keys, mouse, wheel, answers, variable sliders, green flag, stop, turbo) goes
// through input(), which queues it for the next frame and logs it with that frame number.
// Replaying the log against the same project reproduces the run exactly.
// Projects run with stock settings: compiler on, the project's own framerate.

const {EPOCH, setVirtualTime, seedRandom} = window.RunnerDeterminism;

// Math.random seed, applied while loading and again just before the first frame.
const SEED = 1;

// Frames between state hashes.
export const CHECK_INTERVAL = 30;

// Scaffolding starts dragging a sprite after the mouse is held this long without moving.
const DRAG_HOLD_MS = 400;
const DRAG_DISTANCE = 3;

export const fnv1a = str => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
};

const round = n => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

/**
 * Hash of everything observable about the project's state, grouped by sprite (clones are
 * folded into their sprite) so that a mismatch says where things diverged.
 */
/**
 * The state hashState() covers, flattened to "sprite#clone.field" keys for debugging which value
 * diverged. Lists are summarized by length and hash, since they can be huge.
 */
export const dumpState = vm => {
    const dump = {};
    const counts = {};
    for (const t of vm.runtime.targets) {
        const name = t.isStage ? '(stage)' : t.getName();
        const prefix = `${name}#${counts[name] = (counts[name] || 0) + 1}`;
        Object.assign(dump, {
            [`${prefix}.x`]: round(t.x),
            [`${prefix}.y`]: round(t.y),
            [`${prefix}.direction`]: round(t.direction),
            [`${prefix}.size`]: round(t.size),
            [`${prefix}.costume`]: t.currentCostume,
            [`${prefix}.visible`]: t.visible,
            [`${prefix}.layer`]: t.getLayerOrder()
        });
        for (const k of Object.keys(t.effects)) {
            dump[`${prefix}.effect.${k}`] = round(t.effects[k]);
        }
        for (const v of Object.values(t.variables)) {
            dump[`${prefix}.var.${v.name}`] = Array.isArray(v.value) ?
                `list of ${v.value.length}, hash ${fnv1a(JSON.stringify(v.value.map(round)))}` :
                round(v.value);
        }
    }
    return dump;
};

export const hashState = vm => {
    const groups = {};
    for (const t of vm.runtime.targets) {
        const name = t.isStage ? '(stage)' : t.getName();
        (groups[name] || (groups[name] = [])).push([
            t.isOriginal,
            round(t.x), round(t.y), round(t.direction), round(t.size),
            t.currentCostume, t.visible, t.getLayerOrder(), t.rotationStyle, t.draggable,
            Object.keys(t.effects).sort().map(k => round(t.effects[k])),
            Object.keys(t.variables).sort().map(id => {
                const v = t.variables[id];
                return [v.name, Array.isArray(v.value) ? v.value.map(round) : round(v.value)];
            })
        ]);
    }
    const targets = {};
    for (const name of Object.keys(groups).sort()) {
        targets[name] = fnv1a(JSON.stringify(groups[name]));
    }
    return {hash: fnv1a(JSON.stringify(targets)), targets};
};

/**
 * How many passes over the thread list a frame makes depends on time: the sequencer keeps going
 * while less than 75% of the frame interval has passed, unless something requested a redraw
 * (turbo mode ignores redraws). shouldContinue(passes, elapsedMs) replaces that time check, so
 * a recording can use real time and count the passes, and a replay can make the same number of
 * passes no matter how fast the machine or VM is. Returns a function giving this frame's passes.
 *
 * The warp timer is replaced too. Warp-mode threads normally yield after 500 ms of real time,
 * which makes where they stop depend on machine and VM speed. Instead, warp mode behaves as
 * on an infinitely fast machine:
 * - Loops and procedure calls never stop for time, so compute runs to completion within its frame.
 * - A block that is waiting (wait, wait until, a compiled loop whose condition reads the timer)
 *   yields right away. Within a frame nothing it waits on can change (time is virtual and
 *   frozen, other threads and inputs only run between frames), so spinning would end in the
 *   same state.
 * Interpreter: the sequencer compares thread.warpTimer.timeElapsed() with WARP_TIME as
 * "elapsed <= 500 keeps a yielded block spinning" and "elapsed > 500 stops a loop or a
 * procedure call". NaN makes both comparisons false: waits yield, loops keep going.
 * Compiler: isStuck() (only emitted at waiting sites) reads sequencer.timer, which reports
 * Infinity inside threads, so it always yields.
 * A warp loop that runs longer than warpLimitMs throws (interpreter only; a compiled loop
 * without a waiting site never checks).
 */
const patchSequencer = (runtime, warpLimitMs, shouldContinue) => {
    const sequencer = runtime.sequencer;
    const originalStepThread = sequencer.stepThread;
    let insideThread = 0;
    let passes = 0;
    let frameStart = 0;
    let threadStart = 0;
    const fakeWarpTimer = {
        start () {},
        timeElapsed () {
            if (performance.now() - threadStart > warpLimitMs) {
                throw new Error(`A warp-mode script ran for ${warpLimitMs / 1000} s without finishing`);
            }
            return NaN;
        }
    };
    sequencer.stepThread = function (thread) {
        if (insideThread === 0) threadStart = performance.now();
        // The interpreter only creates its own warp timer when the thread has none.
        thread.warpTimer = fakeWarpTimer;
        insideThread++;
        try {
            return originalStepThread.call(this, thread);
        } finally {
            insideThread--;
        }
    };
    sequencer.timer = {
        start () {
            passes = 0;
            frameStart = performance.now();
        },
        time () {
            return performance.now();
        },
        timeElapsed () {
            // The sequencer stops for a redraw request after asking for the time; say stop here
            // instead, so the count is the number of passes actually made.
            if (insideThread > 0 || (runtime.redrawRequested && !runtime.turboMode)) {
                return Infinity;
            }
            if (shouldContinue(passes, performance.now() - frameStart)) {
                passes++;
                return 0;
            }
            return Infinity;
        }
    };
    return () => passes;
};

/**
 * SVG costumes finish loading asynchronously after loadProject() resolves, and until then their
 * bounds are wrong (which affects fencing and touching). Wait for them so the first frame does
 * not depend on timing. Uses renderer internals; there is no public API for this.
 */
const waitForSkins = async renderer => {
    // Empty SVGs never set _svgImageLoaded.
    const isPending = skin => skin && skin._svgImage && !skin._svgImageLoaded && skin.size[0] > 0 && skin.size[1] > 0;
    for (;;) {
        const pending = renderer._allSkins.filter(isPending);
        if (!pending.length) return;
        // An image can report complete while its load event is still queued, so wait a task.
        await new Promise(resolve => setTimeout(resolve, 10));
        // One that finished loading and is still not ready is broken, and will stay that way.
        if (pending.every(skin => skin._svgImage.complete && isPending(skin))) return;
    }
};

// MessageChannel instead of setTimeout(0), which gets clamped to 4 ms after a few nested calls.
const yieldToEventLoop = (() => {
    const channel = new MessageChannel();
    const queue = [];
    channel.port1.onmessage = () => queue.shift()();
    return () => new Promise(resolve => {
        queue.push(resolve);
        channel.port2.postMessage(null);
    });
})();

// crypto.subtle only exists in secure contexts (HTTPS or localhost), and devices usually reach
// the server over plain HTTP on a LAN or Tailscale address, so fall back to plain JavaScript.
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const sha256Fallback = buffer => {
    const bytes = new Uint8Array(buffer);
    // Message, a 1 bit, zero padding, and the length in bits as a 64-bit big-endian number.
    const length = (Math.ceil((bytes.length + 9) / 64)) * 64;
    const padded = new Uint8Array(length);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(length - 4, (bytes.length * 8) >>> 0);

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + (i * 4));
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i];
            const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }
    return Array.from(h, n => n.toString(16).padStart(8, '0')).join('');
};

const sha256 = async data => {
    if (!(globalThis.crypto && crypto.subtle)) {
        return sha256Fallback(data);
    }
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Copy only the fields each input type uses, so a recording never depends on extra
 * properties of DOM events.
 */
const normalizeInput = event => {
    switch (event.type) {
    case 'greenFlag':
    case 'stop':
        return {type: event.type};
    case 'key':
        return {type: 'key', key: String(event.key), keyCode: event.keyCode, down: !!event.down};
    case 'mouse': {
        const out = {type: 'mouse', x: +event.x, y: +event.y};
        if (typeof event.down === 'boolean') {
            out.down = event.down;
            out.button = event.button || 0;
        }
        return out;
    }
    case 'wheel':
        return {type: 'wheel', dx: +event.dx || 0, dy: +event.dy || 0};
    case 'answer':
        return {type: 'answer', text: String(event.text)};
    case 'variable':
        return {type: 'variable', target: event.target, id: String(event.id), value: event.value};
    case 'turbo':
        return {type: 'turbo', on: !!event.on};
    default:
        throw new Error(`Unknown input type: ${event.type}`);
    }
};

const isMouseMove = event => event.type === 'mouse' && !('down' in event);

export class Runner {
    /**
     * @param {object} options
     * @param {object} options.libs window.RunnerLibs from a build.
     * @param {HTMLCanvasElement} options.canvas Its CSS size is managed by the runner
     *   (always the stage size) because mouse picking depends on it. Scale a parent instead.
     * @param {number[]} [options.passes] Passes over the threads to make in each frame, from a
     *   recording. Without it, frames make as many passes as fit in 75% of the frame interval
     *   (stopping at a redraw request outside turbo mode, or after one pass if fillFrames is
     *   turned off), and the passes are recorded.
     * @param {number} [options.warpLimitMs]
     */
    constructor ({libs, canvas, passes = null, warpLimitMs = 60000}) {
        this.canvas = canvas;

        this.renderer = new libs.Renderer(canvas);
        this.vm = new libs.VM();
        this.vm.attachStorage(new libs.ScratchStorage());
        this.vm.attachRenderer(this.renderer);
        this.vm.attachV2BitmapAdapter(new libs.SVGRenderer.BitmapAdapter());

        this.errors = [];
        this.compileErrors = 0;
        this.vm.on('COMPILE_ERROR', () => {
            this.compileErrors++;
        });
        const onError = e => this.errors.push(String((e && (e.message || e.reason || e.error)) || e));
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onError);

        // The frame at which the WebGL context was lost (the GPU process restarted, or the device
        // reclaimed it under memory pressure), or null. Nothing draws after that, so timings and
        // snapshots are meaningless. Builds of scratch-render without the event never set it.
        this.contextLostFrame = null;
        this.renderer.on('ContextLost', () => {
            if (this.contextLostFrame === null) this.contextLostFrame = this.frame;
        });

        this.drawMs = 0;
        this._frameDrawMs = 0;
        const runner = this;
        const originalDraw = this.renderer.draw;
        this._draw = () => originalDraw.call(this.renderer);
        this.renderer.draw = function () {
            const start = performance.now();
            originalDraw.call(this);
            runner._frameDrawMs += performance.now() - start;
        };

        this._framePasses = patchSequencer(this.vm.runtime, warpLimitMs, (count, elapsedMs) => {
            if (passes) {
                return count < passes[this.frame];
            }
            // Without fillFrames, frames outside turbo mode make one pass as if a redraw were always
            // requested, so scripts that busy-wait (e.g. "wait until" on the timer) do not spin
            // for the rest of the frame. Many projects depend on more passes, so it is opt-in.
            if (!this.vm.runtime.turboMode && !this.fillFrames) {
                return count < 1;
            }
            return elapsedMs < 0.75 * this.frameInterval;
        });
        this.vm.on('STAGE_SIZE_CHANGED', () => this._resize());
        this._resize();

        // Like stock TurboWarp: keep stepping until a redraw is requested or 75% of the frame
        // interval is used. Turning it off caps frames at one pass, for projects that only
        // busy-wait. Can change at any time; the passes are recorded either way.
        this.fillFrames = true;
        this.frame = 0;
        this.executeMs = 0;
        // Time spent hashing state, which a benchmark should not count.
        this.checkMs = 0;
        // Frames at which to keep a full dumpState(), for debugging mismatches.
        this.dumpFrames = new Set();
        this.dumps = {};
        this.inputs = [];
        this.hashes = [];
        this.passes = [];
        this._pending = [];
        this._mouse = {x: 0, y: 0, press: null, dragId: null, dragStartMouse: null, dragStartSprite: null};
    }

    get stageWidth () {
        return this.vm.runtime.stageWidth;
    }

    get stageHeight () {
        return this.vm.runtime.stageHeight;
    }

    _resize () {
        this.canvas.style.width = `${this.stageWidth}px`;
        this.canvas.style.height = `${this.stageHeight}px`;
        // The renderer multiplies by devicePixelRatio. Undo that so the drawing buffer, and
        // with it snapshots, are the same size on every machine.
        const ratio = window.devicePixelRatio || 1;
        this.renderer.resize(this.stageWidth / ratio, this.stageHeight / ratio);
    }

    async load (projectData) {
        this.projectSha256 = await sha256(projectData);
        // Seeded during loading too so sprite IDs are stable, but reseeded before the first
        // frame because how much randomness loading uses can differ between VM versions.
        seedRandom(SEED);
        setVirtualTime(EPOCH);
        await this.vm.loadProject(projectData);
        await waitForSkins(this.renderer);

        // The project's own setting; 0 ("screen refresh rate") runs as 60.
        this.framerate = this.vm.runtime.frameLoop.framerate;
        this.fps = this.framerate || 60;
        this.frameInterval = 1000 / this.fps;
        this.vm.runtime.currentStepTime = this.frameInterval;
        this._dragHoldFrames = Math.ceil(DRAG_HOLD_MS / this.frameInterval);
        this.renderer.draw();
    }

    /**
     * Queue an input for the next frame and log it. Consecutive mouse moves (or changes to the
     * same variable) within a frame are merged since only the last one can be observed.
     * @returns {object} The logged input, with its frame.
     */
    input (event) {
        const input = {frame: this.frame, ...normalizeInput(event)};
        const last = this._pending[this._pending.length - 1];
        const mergeable = last && (
            (isMouseMove(input) && isMouseMove(last)) ||
            (input.type === 'variable' && last.type === 'variable' && input.target === last.target && input.id === last.id)
        );
        if (mergeable) {
            this._pending[this._pending.length - 1] = input;
            this.inputs[this.inputs.length - 1] = input;
        } else {
            this._pending.push(input);
            this.inputs.push(input);
        }
        return input;
    }

    _apply (input) {
        const {vm} = this;
        switch (input.type) {
        case 'greenFlag':
            vm.greenFlag();
            break;
        case 'stop':
            vm.stopAll();
            break;
        case 'turbo':
            vm.setTurboMode(input.on);
            break;
        case 'key':
            vm.postIOData('keyboard', {key: input.key, keyCode: input.keyCode, isDown: input.down});
            break;
        case 'mouse':
            this._applyMouse(input);
            break;
        case 'wheel':
            vm.postIOData('mouseWheel', {deltaX: input.dx, deltaY: input.dy});
            break;
        case 'answer':
            vm.runtime.emit('ANSWER', input.text);
            break;
        case 'variable': {
            const target = input.target === null ?
                vm.runtime.getTargetForStage() :
                vm.runtime.getSpriteTargetByName(input.target);
            if (target && target.variables[input.id]) {
                vm.setVariableValue(target.id, input.id, input.value);
            }
            break;
        }
        }
    }

    // Client coordinates relative to the canvas, which is always stage-sized.
    _client (x, y) {
        return {x: x + (this.stageWidth / 2), y: (this.stageHeight / 2) - y};
    }

    // Mouse handling, including dragging draggable sprites, follows TurboWarp/scaffolding,
    // except that the long-press drag is timed in frames so it replays identically.
    _applyMouse (input) {
        const {vm} = this;
        const mouse = this._mouse;
        const client = this._client(input.x, input.y);
        const data = {...client, canvasWidth: this.stageWidth, canvasHeight: this.stageHeight};
        mouse.x = input.x;
        mouse.y = input.y;

        if (!('down' in input)) {
            if (mouse.press && mouse.dragId === null) {
                const distance = Math.hypot(input.x - mouse.press.x, input.y - mouse.press.y);
                if (distance > DRAG_DISTANCE) {
                    this._startDrag(input.x, input.y);
                    mouse.press = null;
                }
            } else if (mouse.dragId !== null) {
                vm.postSpriteInfo({
                    x: input.x - mouse.dragStartMouse.x + mouse.dragStartSprite.x,
                    y: input.y - mouse.dragStartMouse.y + mouse.dragStartSprite.y,
                    force: true
                });
            }
            vm.postIOData('mouse', data);
            return;
        }

        data.isDown = input.down;
        data.button = input.button;
        if (input.down) {
            if (input.button === 0) {
                mouse.press = {x: input.x, y: input.y, frame: input.frame};
            }
            vm.postIOData('mouse', data);
        } else {
            mouse.press = null;
            data.wasDragged = mouse.dragId !== null;
            vm.postIOData('mouse', data);
            if (mouse.dragId !== null) {
                vm.stopDrag(mouse.dragId);
                mouse.dragId = null;
            }
        }
    }

    _startDrag (x, y) {
        const mouse = this._mouse;
        const client = this._client(x, y);
        const drawableId = this.renderer.pick(client.x, client.y);
        if (drawableId === -1 || drawableId === false) return;
        const targetId = this.vm.getTargetIdForDrawableId(drawableId);
        if (targetId === null) return;
        const target = this.vm.runtime.getTargetById(targetId);
        if (!target.draggable) return;
        target.goToFront();
        mouse.dragId = targetId;
        mouse.dragStartMouse = {x, y};
        mouse.dragStartSprite = {x: target.x, y: target.y};
        this.vm.startDrag(targetId);
    }

    /**
     * Run one frame: apply queued inputs, step the VM, and hash the state every CHECK_INTERVAL
     * frames. Then yield to the event loop, so that blocks waiting on promises (sounds, ask,
     * extensions) settle between the same two frames every time. Running several frames without
     * yielding would make those depend on how frames happened to be grouped.
     * @returns {Promise<{executeMs: number, drawMs: number}>} Time spent in this frame.
     */
    async step () {
        if (this.frame === 0) {
            seedRandom(SEED);
        }
        setVirtualTime(EPOCH + (this.frame * this.frameInterval));
        for (const input of this._pending) {
            this._apply(input);
        }
        this._pending.length = 0;

        const press = this._mouse.press;
        if (press && this._mouse.dragId === null && this.frame - press.frame >= this._dragHoldFrames) {
            this._startDrag(press.x, press.y);
            this._mouse.press = null;
        }

        this._frameDrawMs = 0;
        const start = performance.now();
        this.vm.runtime._step();
        const totalMs = performance.now() - start;
        const drawMs = this._frameDrawMs;
        this.executeMs += totalMs - drawMs;
        this.drawMs += drawMs;
        this.passes.push(this._framePasses());

        this.frame++;
        if (this.frame % CHECK_INTERVAL === 0) {
            const checkStart = performance.now();
            this.hashes.push(hashState(this.vm).hash);
            this.checkMs += performance.now() - checkStart;
        }
        if (this.dumpFrames.has(this.frame)) {
            const dumpStart = performance.now();
            this.dumps[this.frame] = dumpState(this.vm);
            this.checkMs += performance.now() - dumpStart;
        }
        await yieldToEventLoop();
        return {executeMs: totalMs - drawMs, drawMs};
    }

    /** Capture the stage (without monitors) as a PNG data URL. */
    snapshot () {
        let url;
        this.renderer.requestSnapshot(dataURL => {
            url = dataURL;
        });
        // draw() does nothing unless something changed; force it, untimed.
        this.renderer.dirty = true;
        this._draw();
        return url;
    }

    /** State checks for the frames run so far. */
    checks () {
        return {
            interval: CHECK_INTERVAL,
            hashes: [...this.hashes],
            final: {frame: this.frame, ...hashState(this.vm)}
        };
    }
}
