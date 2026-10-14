import { extractBlocksSync } from '../../../apps/extension/src/dom/extractor';
import { DomRenderer } from '../../../apps/extension/src/dom/renderer';

// Browser-only bridge used by the offline structural regression. No provider calls.
Object.assign(window, {
  plPreviewRegression: {
    extract: () => extractBlocksSync(document),
    renderer: () => new DomRenderer(),
  },
});
