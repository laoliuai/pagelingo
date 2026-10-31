import { parentPort, workerData } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';
import { SaxesParser } from 'saxes';

const MAX_SIDE = 2048;
const options = { background: 'white', font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } };

/** An SVG may only embed its own bytes: a DOCTYPE or an outside href could make the renderer read local files. */
function assertSelfContained(svg: string): void {
  const parser = new SaxesParser();
  parser.on('error', error => { throw error; });
  parser.on('doctype', () => { throw new Error('SVG DOCTYPE is not allowed'); });
  parser.on('opentag', tag => {
    if (tag.name.split(':').at(-1) !== 'image') return;
    for (const [name, value] of Object.entries(tag.attributes)) {
      if (name.split(':').at(-1) === 'href' && !String(value).trim().toLowerCase().startsWith('data:image/')) throw new Error('SVG references an outside image');
    }
  });
  parser.write(svg).close();
}

try {
  const svg = Buffer.from(workerData.svg as Uint8Array).toString('utf8');
  assertSelfContained(svg);
  const measured = new Resvg(svg, options);
  const side = Math.max(measured.width, measured.height);
  if (!(side > 0)) throw new Error('SVG has no size');
  const zoom = Math.min(2, MAX_SIDE / side);
  const png = new Resvg(svg, { ...options, fitTo: { mode: 'zoom', value: zoom } }).render().asPng();
  parentPort!.postMessage({ ok: true, png: new Uint8Array(png) });
} catch {
  parentPort!.postMessage({ ok: false });
}
