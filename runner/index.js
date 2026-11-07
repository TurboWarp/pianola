// Start page for devices: pick a name, check what the device reports, and start a worker.

import {detectAlteredReadback} from './readback.js';

const $ = id => document.getElementById(id);

const name = $('name');
name.value = localStorage.getItem('worker-name') || '';

$('start').addEventListener('submit', e => {
    e.preventDefault();
    const value = name.value.trim();
    localStorage.setItem('worker-name', value);
    location.href = `worker.html?${new URLSearchParams({name: value})}`;
});

const gpu = () => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

const readbackProblem = detectAlteredReadback();
if (readbackProblem) {
    $('readback-warning').textContent = `Warning: ${readbackProblem} (anti-fingerprinting). Projects that read pixels behave randomly here, so their state checks fail. Use a browser without it, or turn it off for this site.`;
    $('readback-warning').hidden = false;
}

// Smallest step performance.now() takes, which cross-origin isolation makes finer.
const timerResolution = () => {
    let smallest = Infinity;
    const end = performance.now() + 50;
    for (let i = 0; i < 1000 && performance.now() < end; i++) {
        const a = performance.now();
        let b;
        do b = performance.now(); while (b === a);
        smallest = Math.min(smallest, b - a);
    }
    return smallest;
};

const rows = [
    ['browser', navigator.userAgent],
    ['gpu', gpu()],
    ['screen', `${screen.width}x${screen.height} @${devicePixelRatio}x`],
    ['cores', navigator.hardwareConcurrency || '?'],
    ['readback', readbackProblem || 'exact'],
    ['secure', window.isSecureContext ? 'yes' : 'no (the screen cannot be kept awake automatically)'],
    ['timer', `${(timerResolution() * 1000).toFixed(1)} µs, ${window.crossOriginIsolated ?
        'cross-origin isolated' :
        'not cross-origin isolated (needs a secure context: localhost or HTTPS)'}`]
];
for (const [label, value] of rows) {
    const tr = $('device').insertRow();
    const th = document.createElement('th');
    th.textContent = label;
    tr.appendChild(th);
    tr.insertCell().textContent = value;
    if ((label === 'readback' && readbackProblem) || (label === 'timer' && !window.crossOriginIsolated)) tr.className = 'bad';
}
