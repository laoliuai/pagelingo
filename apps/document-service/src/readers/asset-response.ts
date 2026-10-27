import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendStoredAsset } from '../documents/source-response.js';
import type { ObjectStore } from '../storage/object-store.js';
import { notFound, type AssetRow } from './repository.js';

export function sendReaderAsset(request: FastifyRequest, reply: FastifyReply, store: ObjectStore, asset: AssetRow, archive = false) {
  if (archive ? asset.media_type !== 'application/zip' : !['image/png', 'image/jpeg', 'image/webp'].includes(asset.media_type)) throw notFound();
  const extension = archive ? 'zip' : asset.media_type === 'image/jpeg' ? 'jpg' : asset.media_type.split('/')[1]!;
  const filename = archive ? 'document-bundle.zip' : `image.${extension}`;
  return sendStoredAsset(request, reply, store, asset, { mediaType: asset.media_type, filename, fallbackFilename: filename, download: archive });
}
