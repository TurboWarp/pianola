# Pianola

A portion of the tooling we use to benchmark TurboWarp.

## Methodology

1. We want to benchmark real projects, not synthetic microbenchmarks. To that end, we downloaded a [corpus](corpus.json) of 149 real projects from the Scratch website. We found these from [TurboWarp featured projects](https://scratch.mit.edu/studios/27205657/), [3D Graphics and Scratch](https://scratch.mit.edu/studios/32030084), [windchimes](https://github.com/TurboWarp/windchimes) historical view data, and some other places.

2. Because these are real projects and not benchmarks, there are often various steps that have to be taken to exercise the interesting code paths of the project, like clicking some buttons or moving around. To do that, we made the [painter](./painter/), manually opened every project, and recorded a [series of inputs](./recordings) that results in sufficiently interesting behaviors.

3. You now have a set of benchmarks and inputs for them. To turn these into data, we have three components:

    1. The [coordinator](./coordinator) is a tiny web server. It serves the builds of the VM being compared, assigns work out, and stores the results. For best results, serve over a secure context (localhost or HTTPS; I personally use [tailscale serve](https://tailscale.com/docs/features/tailscale-serve)) as this lets us use [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) to access higher resolution timers from the browser.

    2. The [runner](./runner) listens for assignments from the coordination server, loads the specified VM and project, applies determinism to random number and time blocks (among other things), replays inputs from the painter, and sends back the results (timing data, snapshots, other verification data). This is opened in any regular headful browser on any computer. We can open this up in as many real browsers as we want to horizontally scale compute available for benchmarking.

    3. An [optional Chrome browser extension](./profiler-extension) uses [chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) to trace line-by-line performance data from the browser, with more depth and accuracy than TurboWarp's [sampler](https://github.com/TurboWarp/scratch-vm/blob/develop/src/engine/tw-sampler.js) can do. This data, along with compiled script metadata for lining up profiles, is sent by the runner to the coordinator too.

4. We want to make sure that projects become faster because we are doing the work faster, not because we broke the project and made it not compute anything interesting. To ensure this, we take screenshots (of the stage and of variable state and some other things) periodically during benchmark runs. We compare between runtime versions in the same browser on the same computer to check if these match.

    We've found that different browsers and computers often render the same scenes differently for benign reasons, so we cannot just have one known-good snapshot to compare against. We've tried to record inputs in such a way that subtle changes in color scanning, for example, won't result in substantial divergence that compromises the value of the benchmark.

Limitations:

- This is not a conformance or compatibility test. We only care for checking differential regressions between two builds; not comparing against a "known-good".
- This may not work well for benchmarking anything that isn't derived from Scratch 3. Minor differences in how things like rendering or collision are implemented can feasibly cause substantial divergence that the scripted inputs can't correct.

## How to run it.

1. Install dependencies, build each version of the VM you want to compare, and start the coordinator. A build is any [scratch-vm](https://github.com/TurboWarp/scratch-vm) checkout, optionally at a specific git ref.

    ```sh
    npm ci
    npm run build -- --name before --vm ../scratch-vm@develop
    npm run build -- --name after --vm ../scratch-vm
    npm start
    ```

2. Open http://localhost:8100/runner/ (or whatever other URL you made the coordinator accessible at) on the computer and browser that you want to benchmark in.

3. Submit a batch. This waits for the workers to finish, then prints each project's time per frame for every build, how the second build compares to the first, and any projects whose snapshots didn't match.

    ```sh
    node coordinator/bench.js --build before --build after
    ```

    Without `--project <id>`, every project is run. `--repeat <n>` runs each one more times, `--device <name>` limits the batch to workers with that name, and `--trace` records a Chrome trace of each job on workers with the profiler extension.

Keep the worker tab visible while it runs, because browsers throttle hidden tabs, so a job whose tab gets hidden is abandoned and run again. You can watch the queue at http://localhost:8100/runner/queue.html.

To record inputs for a new project, add it to [corpus.json](corpus.json) and open http://localhost:8100/painter/.
