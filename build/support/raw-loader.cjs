// Minimal replacement for raw-loader that always returns a CommonJS string export.
module.exports = function rawLoader (source) {
    return `module.exports = ${JSON.stringify(source)};`;
};
