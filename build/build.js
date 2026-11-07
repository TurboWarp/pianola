// Bundles a scratch-vm checkout (and optionally a scratch-render checkout) into
// dist/builds/<name>/libs.js for the runner page to load, with a source map (libs.js.map) so
// traces of the production bundle can be mapped back to the original code.
//
//   node build/build.js --name <name> --vm <path>[@ref] [--render <path>[@ref]] [--dev]
//
// Sources are given as "path" (working tree as-is, including uncommitted changes)
// or "path@ref" (the ref is checked out into a detached worktree under .cache/).

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import webpack from 'webpack';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const support = path.join(import.meta.dirname, 'support');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim();

const parseSource = spec => {
    const at = spec.lastIndexOf('@');
    // Ignore "@" that is part of a scoped path segment like node_modules/@foo
    if (at > 0 && !/[\\/]/.test(spec.slice(at))) {
        return {dir: path.resolve(spec.slice(0, at)), ref: spec.slice(at + 1)};
    }
    return {dir: path.resolve(spec), ref: null};
};

/**
 * Resolve a source spec to a directory containing the code to bundle, plus
 * metadata describing exactly what was bundled.
 */
export const prepareSource = (spec, label) => {
    const {dir, ref} = parseSource(spec);
    if (!fs.existsSync(dir)) {
        throw new Error(`${label}: ${dir} does not exist`);
    }
    const isGit = fs.existsSync(path.join(dir, '.git'));
    if (!ref) {
        const info = {spec, dir};
        if (isGit) {
            info.commit = git(dir, 'rev-parse', 'HEAD');
            info.branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
            info.dirty = git(dir, 'status', '--porcelain', '--untracked-files=no') !== '';
        }
        return {codeDir: dir, info};
    }

    if (!isGit) {
        throw new Error(`${label}: ${dir} is not a git repository, cannot check out ${ref}`);
    }
    const commit = git(dir, 'rev-parse', '--verify', `${ref}^{commit}`);
    const worktree = path.join(ROOT, '.cache', 'worktrees', `${path.basename(dir)}-${commit}`);
    if (!fs.existsSync(worktree)) {
        fs.mkdirSync(path.dirname(worktree), {recursive: true});
        git(dir, 'worktree', 'add', '--detach', worktree, commit);
    }
    // Reuse the main checkout's dependencies. This is wrong if the ref changed
    // package.json in a way that matters, but it keeps builds fast.
    const modules = path.join(worktree, 'node_modules');
    if (!fs.existsSync(modules) && fs.existsSync(path.join(dir, 'node_modules'))) {
        fs.symlinkSync(path.join(dir, 'node_modules'), modules, 'junction');
    }
    return {codeDir: worktree, info: {spec, dir, ref, commit, dirty: false}};
};

export const build = async ({name, vm, render, dev}) => {
    if (!name || !/^[\w.-]+$/.test(name)) {
        throw new Error('--name is required and may only contain letters, numbers, ".", "_", "-"');
    }
    if (!vm) {
        throw new Error('--vm is required');
    }
    const vmSource = prepareSource(vm, 'vm');
    const renderSource = render ?
        prepareSource(render, 'render') :
        {codeDir: path.dirname(require.resolve('scratch-render/package.json')), info: {spec: 'node_modules/scratch-render'}};

    const outDir = path.join(ROOT, 'dist', 'builds', name);
    // Built next to the old one and swapped in, so pages loading the build meanwhile never see
    // it half written.
    const tempDir = `${outDir}.tmp`;
    fs.rmSync(tempDir, {recursive: true, force: true});

    const mode = dev ? 'development' : 'production';
    const config = {
        mode,
        // A separate map file only adds a comment to libs.js; the code that runs is unchanged.
        devtool: 'source-map',
        context: ROOT,
        entry: path.join(import.meta.dirname, 'libs-entry.js'),
        output: {
            path: tempDir,
            filename: 'libs.js'
        },
        performance: {hints: false},
        resolve: {
            alias: {
                'scratch-vm$': vmSource.codeDir,
                'scratch-render$': renderSource.codeDir,
                'text-encoding$': path.join(support, 'text-encoding.cjs'),
                // Only used by the editor for parsing blocks XML.
                'htmlparser2$': path.join(support, 'empty-module.cjs')
            },
            // Each checkout's own node_modules wins; ours is the fallback for
            // checkouts without dependencies installed (e.g. a bare scratch-render clone).
            modules: ['node_modules', path.join(ROOT, 'node_modules')],
            fallback: {
                buffer: require.resolve('buffer/'),
                events: require.resolve('events/'),
                stream: false
            }
        },
        resolveLoader: {
            modules: ['node_modules', path.join(ROOT, 'node_modules')],
            alias: {
                'raw-loader': path.join(support, 'raw-loader.cjs'),
                'worker-loader': path.join(support, 'stub-loader.cjs')
            }
        },
        module: {
            rules: [
                {
                    test: /\.mp3$/i,
                    use: path.join(support, 'stub-loader.cjs')
                }
            ]
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(mode)
            }),
            new webpack.ProvidePlugin({
                Buffer: ['buffer', 'Buffer']
            }),
            // The iframe extension worker uses webpack 4 internals. Custom extensions are out of scope.
            new webpack.NormalModuleReplacementPlugin(
                /tw-iframe-extension-worker$/,
                path.join(support, 'empty-module.cjs')
            )
        ]
    };

    const stats = await new Promise((resolve, reject) => {
        webpack(config, (err, result) => (err ? reject(err) : resolve(result)));
    });
    if (stats.hasErrors()) {
        throw new Error(stats.toString({all: false, errors: true, errorDetails: true}));
    }

    const info = {
        name,
        builtAt: new Date().toISOString(),
        mode,
        vm: vmSource.info,
        render: renderSource.info
    };
    fs.writeFileSync(path.join(tempDir, 'build.json'), JSON.stringify(info, null, 2));
    fs.rmSync(outDir, {recursive: true, force: true});
    fs.renameSync(tempDir, outDir);
    return info;
};

if (import.meta.main) {
    const {values} = parseArgs({
        options: {
            name: {type: 'string'},
            vm: {type: 'string'},
            render: {type: 'string'},
            dev: {type: 'boolean', default: false}
        }
    });
    const info = await build(values);
    console.log(`Built ${info.name}: vm ${info.vm.commit || info.vm.dir}${info.vm.dirty ? ' (dirty)' : ''}`);
}
