import { posix } from 'node:path';
import { inspectImage } from '@pagelingo/document-bundle';
import type { ReaderAsset } from '@pagelingo/document-contracts';
import type { VerifiedPreview } from './local-run.js';
import { readVerified, requireInput, sha256 } from './verified-input.js';
export async function legacyAsset(
  preview: VerifiedPreview,
  pagePath: string,
  src: string,
): Promise<ReaderAsset> {
  requireInput(
    !/^[a-z]+:|^\/|[\\?#\x00-\x1f]/i.test(src),
    'External or unsafe image source',
  );
  const path = posix.normalize(posix.join(posix.dirname(pagePath), src));
  const data = await readVerified(preview, path);
  const image = inspectImage(data);
  requireInput(
    image.width <= 16384 &&
      image.height <= 16384 &&
      image.width * image.height <= 40000000,
    'Image dimensions exceed limits',
  );
  const hash = sha256(data);
  const extension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  }[image.mediaType];
  const target = `assets/${hash}.${extension}`;
  preview.assetFiles.set(target, path);
  return {
    id: `a_${hash}`,
    path: target,
    sha256: hash,
    bytes: data.length,
    ...image,
  };
}
