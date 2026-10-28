import { expect, it } from 'vitest';
import { parseArxivAtom } from '../../src/source-adapters/arxiv-atom.js';
import { atom } from '../helpers/arxiv-fixture.js';
const request = { provider: 'arxiv' as const, baseId: '2401.12345', version: null, url: 'https://arxiv.org/abs/2401.12345' };
const parse = (xml: string) => parseArxivAtom(Buffer.from(xml), request);
it.each(['2401.12345', 'hep-th/9901001'])('reads a single actual fixed Atom entry for %s', baseId => {
  expect(() => parseArxivAtom(Buffer.from(atom(baseId, 2)), { ...request, baseId })).not.toThrow();
  expect(parseArxivAtom(Buffer.from(atom(baseId, 2)), { ...request, baseId })).toEqual({ baseId, version: 2, title: 'Paper version 2', authors: ['Alice & Bob'], summary: 'Fixed source summary', publishedAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T03:04:05.000Z', pdfUrl: `https://arxiv.org/pdf/${baseId}v2` });
});
it('rejects mismatched IDs, versions and multiple or missing entries', () => {
  for (const xml of [atom('2401.99999'), atom().replace('v1</id>', '</id>'), atom().replace('</feed>', atom().split('<feed xmlns="http://www.w3.org/2005/Atom">')[1]!), '<feed xmlns="http://www.w3.org/2005/Atom"/>', atom().replace('http://arxiv.org/abs/2401.12345v1', 'http://arxiv.org/api/errors')]) expect(() => parse(xml)).toThrow();
  expect(() => parseArxivAtom(Buffer.from(atom()), { ...request, version: 2 })).toThrow();
});
it.each([
  '<!DOCTYPE feed [<!ENTITY secret SYSTEM "file:///etc/passwd">]>',
  '<!DOCTYPE feed>',
])('rejects declarations without resolving entities: %s', declaration => { expect(() => parse(atom().replace('<?xml version="1.0"?>', declaration))).toThrow(); });
it('enforces byte depth node author and summary caps', () => {
  for (const xml of [atom() + ' '.repeat(1024 * 1024), atom().replace('<entry>', '<entry>' + '<x>'.repeat(32)).replace('</entry>', '</x>'.repeat(32) + '</entry>'), atom().replace('</entry>', '<x/>'.repeat(5000) + '</entry>'), atom().replace('</entry>', '<author><name>A</name></author>'.repeat(1000) + '</entry>'), atom().replace('Fixed source summary', 's'.repeat(20001))]) expect(() => parse(xml)).toThrow();
  expect(parse(atom().replace('Fixed source summary', 's'.repeat(20000))).summary).toHaveLength(20000);
});
it.each(['2024-02-30T00:00:00Z', '2023-02-29T00:00:00Z', '2024-01-01', '2024-01-01T25:00:00Z', '2024-13-01T00:00:00Z'])('rejects invalid Atom dates %s', date => { expect(() => parse(atom().replace('2024-01-02T03:04:05Z', date))).toThrow(); });
it('rejects invalid XML, foreign namespace entries, duplicate metadata and unknown entities', () => {
  for (const xml of [atom().slice(0, -8), atom().replace('http://www.w3.org/2005/Atom', 'urn:untrusted'), atom().replace('</entry>', '<title>Duplicate</title></entry>'), atom().replace('Fixed source summary', '&external;')]) expect(() => parse(xml)).toThrow();
});
it('does not accept a foreign author container as Atom metadata', () => {
  const xml = atom().replace('<author><name>Alice &amp; Bob</name></author>', '<author xmlns="urn:other"><name xmlns="http://www.w3.org/2005/Atom">Forged author</name></author>');
  expect(() => parse(xml)).toThrow();
});
