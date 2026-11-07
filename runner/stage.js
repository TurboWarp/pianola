// The visible part of the runner, adapted from TurboWarp/scaffolding: the canvas, monitors,
// and the "ask" prompt, scaled to fit a container. In interactive mode DOM input is
// translated into runner inputs and passed to onInput; nothing is sent to the VM directly.

import {updateMonitors} from './monitors.js';

const round2 = n => Math.round(n * 100) / 100;

// Keys whose default action (scrolling, going back) would get in the way of playing.
const PREVENT_DEFAULT_KEYS = new Set([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', '\'', '/']);

const isTyping = e => e.target !== document && e.target !== document.body;

export class Stage {
    /**
     * @param {HTMLElement} container The stage is scaled to fit it.
     * @param {object} options
     * @param {boolean} [options.interactive] Capture keyboard and mouse input.
     * @param {(input: object) => void} [options.onInput]
     */
    constructor (container, {interactive = false, onInput = () => {}} = {}) {
        this.interactive = interactive;
        this.onInput = onInput;
        this.monitors = new Map();

        this.root = document.createElement('div');
        this.root.className = 'sc-root';
        this.layers = document.createElement('div');
        this.layers.className = 'sc-layers';
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'sc-canvas';
        this.monitorOverlay = document.createElement('div');
        this.monitorOverlay.className = 'sc-monitor-overlay';
        this.layers.append(this.canvas, this.monitorOverlay);
        this.root.appendChild(this.layers);
        container.appendChild(this.root);

        new ResizeObserver(() => this.fit()).observe(this.root);
    }

    /** Connect to a runner created with this stage's canvas. */
    attach (runner) {
        this.runner = runner;
        this.vm = runner.vm;
        this.vm.on('MONITORS_UPDATE', monitors => updateMonitors(this, monitors));
        this.vm.on('STAGE_SIZE_CHANGED', () => this.fit());
        if (this.interactive) {
            this.vm.runtime.on('QUESTION', question => this._onQuestion(question));
            this._captureInput();
        }
        this.fit();
    }

    // The layers always have the stage's size in CSS pixels (the runner depends on that for
    // mouse picking) and are scaled with a transform instead.
    fit () {
        if (!this.runner) return;
        const {stageWidth, stageHeight} = this.runner;
        const width = this.root.clientWidth;
        const height = this.root.clientHeight;
        const scale = Math.min(width / stageWidth, height / stageHeight);
        const left = (width - (stageWidth * scale)) / 2;
        const top = (height - (stageHeight * scale)) / 2;
        this.layers.style.width = `${stageWidth}px`;
        this.layers.style.height = `${stageHeight}px`;
        this.layers.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
    }

    _stagePosition (e) {
        const rect = this.canvas.getBoundingClientRect();
        const {stageWidth, stageHeight} = this.runner;
        return {
            x: round2((((e.clientX - rect.left) / rect.width) - 0.5) * stageWidth),
            y: round2((0.5 - ((e.clientY - rect.top) / rect.height)) * stageHeight)
        };
    }

    _captureInput () {
        const heldKeys = new Map();
        const heldButtons = new Set();
        let last = {x: 0, y: 0};

        document.addEventListener('mousemove', e => {
            last = this._stagePosition(e);
            this.onInput({type: 'mouse', ...last});
        });
        this.canvas.addEventListener('mousedown', e => {
            last = this._stagePosition(e);
            heldButtons.add(e.button);
            this.onInput({type: 'mouse', ...last, down: true, button: e.button});
        });
        document.addEventListener('mouseup', e => {
            if (!heldButtons.delete(e.button)) return;
            last = this._stagePosition(e);
            this.onInput({type: 'mouse', ...last, down: false, button: e.button});
        });
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            this.onInput({type: 'wheel', dx: e.deltaX, dy: e.deltaY});
        }, {passive: false});

        document.addEventListener('keydown', e => {
            if (isTyping(e)) return;
            if (PREVENT_DEFAULT_KEYS.has(e.key)) e.preventDefault();
            heldKeys.set(e.key, e.keyCode);
            this.onInput({type: 'key', key: e.key, keyCode: e.keyCode, down: true});
        });
        document.addEventListener('keyup', e => {
            if (!heldKeys.delete(e.key)) return;
            this.onInput({type: 'key', key: e.key, keyCode: e.keyCode, down: false});
        });

        // Key and button releases are not delivered while the window is unfocused, so
        // release everything rather than leave it stuck down.
        window.addEventListener('blur', () => {
            for (const [key, keyCode] of heldKeys) {
                this.onInput({type: 'key', key, keyCode, down: false});
            }
            heldKeys.clear();
            for (const button of heldButtons) {
                this.onInput({type: 'mouse', ...last, down: false, button});
            }
            heldButtons.clear();
        });
    }

    _onQuestion (question) {
        if (this.question) {
            this.question.remove();
            this.question = null;
        }
        if (question === null) return;

        const root = document.createElement('div');
        root.className = 'sc-question-root';
        const inner = document.createElement('div');
        inner.className = 'sc-question-inner';
        if (question) {
            const text = document.createElement('div');
            text.className = 'sc-question-text';
            text.textContent = question;
            inner.appendChild(text);
        }
        const outer = document.createElement('div');
        outer.className = 'sc-question-input-outer';
        const input = document.createElement('input');
        input.className = 'sc-question-input';
        const submit = document.createElement('button');
        submit.className = 'sc-question-submit-button';
        submit.textContent = '✓';
        outer.append(input, submit);
        inner.appendChild(outer);
        root.appendChild(inner);
        this.layers.appendChild(root);
        this.question = root;

        const answer = () => {
            input.blur();
            root.remove();
            this.question = null;
            this.onInput({type: 'answer', text: input.value});
        };
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') answer();
        });
        submit.addEventListener('click', answer);
        input.focus();
    }
}
