// Used for things the benchmark never needs (extension workers, music samples).
// The pitch skips reading and processing the original resource entirely.
module.exports = function () {
    return 'module.exports = null;';
};
module.exports.pitch = function () {
    return 'module.exports = null;';
};
