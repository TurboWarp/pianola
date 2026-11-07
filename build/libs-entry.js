// Bundled once per build. Exposes the libraries to the page; everything else
// lives in runner/ so it is identical across builds.
import VM from 'scratch-vm';
import Renderer from 'scratch-render';
import ScratchStorage from '@turbowarp/scratch-storage';
import * as SVGRenderer from '@turbowarp/scratch-svg-renderer';

window.RunnerLibs = {
    VM,
    Renderer,
    ScratchStorage: ScratchStorage.ScratchStorage || ScratchStorage.default || ScratchStorage,
    SVGRenderer
};
