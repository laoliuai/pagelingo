import { validateBundle } from './validate.js';
import { writeValidatedBundle } from './zip-output.js';
import type { BundleFileSource, BundleOptions, BundleIdentity } from './types.js';
/** PDF output always enters the unchanged PDF validator first. */
export function writeBundle(input: BundleFileSource, destination: string, options: BundleOptions): Promise<BundleIdentity> {
  return writeValidatedBundle(input, destination, options, validateBundle);
}
