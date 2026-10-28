import { identityDigest } from '../document-lifecycle/retired-identities.js';
/** Owner is the SQL scope; UUID spelling is canonicalized, Git refs are never folded. */
export const sourceRequestDigest = (documentId: string, authVersion: number, key: string) => identityDigest(JSON.stringify(['source-request', documentId.toLowerCase(), authVersion, key.toLowerCase()]));
export const providerIdentityDigest = (provider: 'github' | 'arxiv', id: string) => identityDigest(JSON.stringify(['source-provider', provider, id]));

/** Store only the provider digest and exact retirement time, never source metadata. */
export async function retireProviderIdentity(client: import('pg').PoolClient, owner: string, documentId: string, phase: 'trash' | 'purge'): Promise<void> {
  const rows = (await client.query<{ provider: 'github' | 'arxiv'; provider_id: string }>('SELECT provider,provider_id FROM document_source_identities WHERE owner_id=$1 AND document_id=$2', [owner,documentId])).rows;
  for (const row of rows) await client.query(`INSERT INTO retired_document_identities(owner_id,document_id,identity_kind,identity_digest,retired_at)
    SELECT owner_id,${phase === 'trash' ? 'id' : 'document_id'},'source-provider',$3,${phase === 'trash' ? 'deleted_at' : 'purged_at'}
    FROM ${phase === 'trash' ? 'documents' : 'document_tombstones'} WHERE owner_id=$1 AND ${phase === 'trash' ? 'id' : 'document_id'}=$2 ON CONFLICT DO NOTHING`, [owner,documentId,providerIdentityDigest(row.provider,row.provider_id)]);
}
