// Makes everything a project can observe deterministic:
//  - Date / Date.now() return a virtual clock that the runner advances by
//    exactly one frame interval per frame. Within a frame, time stands still.
//  - Math.random() is a seeded PRNG.
// performance.now() is left alone; the runner uses it for measurements.
// Loaded as a classic script before the libraries so they only ever see the patched versions.
(() => {
    'use strict';

    const RealDate = Date;
    // 2025-01-01 12:00:00 UTC, so "days since 2000" etc. are stable.
    const EPOCH = RealDate.UTC(2025, 0, 1, 12, 0, 0);
    let virtualNow = EPOCH;

    class VirtualDate extends RealDate {
        constructor (...args) {
            if (args.length === 0) {
                super(virtualNow);
            } else {
                super(...args);
            }
        }
        static now () {
            return virtualNow;
        }
    }
    window.Date = VirtualDate;

    // sfc32, seeded from a 32-bit integer
    let a, b, c, d;
    const random = () => {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
        let t = (a + b) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        d = (d + 1) | 0;
        t = (t + d) | 0;
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
    };
    const seed = s => {
        a = 0x9e3779b9; b = 0x243f6a88; c = 0xb7e15162; d = s >>> 0;
        for (let i = 0; i < 16; i++) random();
    };
    seed(1);
    Math.random = random;

    window.RunnerDeterminism = {
        EPOCH,
        RealDate,
        setVirtualTime: ms => {
            virtualNow = ms;
        },
        seedRandom: seed
    };
})();
