// Detects browsers that alter canvas pixel readback, as anti-fingerprinting features do (Helium,
// Brave, Firefox with resistFingerprinting, ...). Projects that read pixels (touching color, pen)
// then behave randomly, so recordings made there cannot be replayed.

const SIZE = 64;

// Every pixel different, so noise added to only some pixels still shows up.
const pattern = () => {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i++) {
        data[(i * 4) + 0] = (i * 7) & 255;
        data[(i * 4) + 1] = (i * 13) & 255;
        data[(i * 4) + 2] = (i * 29) & 255;
        data[(i * 4) + 3] = 255;
    }
    return data;
};

const differs = (a, b) => {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return true;
    }
    return false;
};

const check2D = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const expected = pattern();
    ctx.putImageData(new ImageData(expected, SIZE, SIZE), 0, 0);
    return differs(expected, ctx.getImageData(0, 0, SIZE, SIZE).data);
};

const checkWebGL = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const gl = canvas.getContext('webgl');
    if (!gl) return false;
    const expected = pattern();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(expected.buffer));
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const actual = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, actual);
    return differs(expected, actual);
};

/** @returns {string|null} What is altered, or null if readback is exact. */
export const detectAlteredReadback = () => {
    const altered = [];
    if (check2D()) altered.push('2D canvas');
    if (checkWebGL()) altered.push('WebGL');
    return altered.length ? `${altered.join(' and ')} pixel readback is altered by this browser` : null;
};
