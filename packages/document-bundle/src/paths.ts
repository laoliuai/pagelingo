import { bundlePathSchema } from '@pagelingo/document-contracts';
import { check } from './errors.js';
export function validatePath(path: string, maxPathBytes: number): void {
  check(
    typeof path === 'string' &&
      Buffer.byteLength(path) <= maxPathBytes &&
      bundlePathSchema.safeParse(path).success,
  );
}
/** Files only. Explicit directories are intentionally not admitted. */
export class PathRegistry {
  private readonly files = new Set<string>();
  private readonly directories = new Map<string, string>();
  constructor(private readonly maxPathBytes: number) {}
  add(path: string): void {
    validatePath(path, this.maxPathBytes);
    const key = path.toLowerCase();
    check(!this.files.has(key) && !this.directories.has(key));
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      check(!this.files.has(parent));
      const spelling = path.split('/').slice(0, i).join('/');
      check(
        !this.directories.has(parent) ||
          this.directories.get(parent) === spelling,
      );
      this.directories.set(parent, spelling);
    }
    this.files.add(key);
  }
}
