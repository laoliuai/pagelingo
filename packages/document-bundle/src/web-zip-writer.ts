import { webFileLimit } from './web-manifest.js';
import { validateWebBundle } from './web-validate.js';
import { writeValidatedBundle } from './zip-output.js';
import type { BundleFileSource, BundleOptions, BundleIdentity } from './types.js';
/** Preserve original manifest bytes and rehash every stream before atomic publication. */
export function writeWebBundle(input: BundleFileSource, destination: string, options: BundleOptions): Promise<BundleIdentity> {
  return writeValidatedBundle(input, destination, options, validateWebBundle, true, webFileLimit);
}
