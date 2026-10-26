export interface ByteRange { start: number; end: number }
export interface StoredObject { bytes: number; sha256: string }
export interface ObjectStore {
  putImmutable(key: string, body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<StoredObject>;
  stat(key: string): Promise<{ bytes: number }>;
  read(key: string, range?: ByteRange): AsyncIterable<Uint8Array>;
  /** Caller must check database references under the publication lock before deletion. */
  deleteUnreferenced(key: string): Promise<void>;
}
