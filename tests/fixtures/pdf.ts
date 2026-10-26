/** A deterministic, synthetic PDF with a valid cross-reference table. */
export function buildPdfFixture(pages = 3): Uint8Array {
  if (!Number.isInteger(pages) || pages < 1) throw new Error('Invalid page count');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] >>`,
  ];
  for (let i = 0; i < pages; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
    );
    const content = `0.${i + 2} 0.45 0.4 rg 24 300 252 60 re f\n0.1 0.1 0.1 rg BT /F1 20 Tf 24 260 Td (PageLingo - Page ${i + 1}) Tj ET\nBT /F1 12 Tf 24 230 Td (A private reading document.) Tj ET\n`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** A small, generated ICC v2 matrix profile swaps red/blue primaries.
 * DeviceRGB fallback paints red; an actual ICC conversion paints blue.
 */
export function buildIccPdfFixture(): Uint8Array {
  function xyz(values: number[]): Buffer {
    const data = Buffer.alloc(20);
    data.write('XYZ ');
    values.forEach((value, index) =>
      data.writeInt32BE(Math.round(value * 65536), 8 + index * 4),
    );
    return data;
  }
  function curve(): Buffer {
    const data = Buffer.alloc(16);
    data.write('curv');
    data.writeUInt32BE(1, 8);
    data.writeUInt16BE(Math.round(2.2 * 256), 12);
    return data;
  }
  const tags: [string, Buffer][] = [
    ['rXYZ', xyz([0.1430804, 0.0606169, 0.7141733])],
    ['gXYZ', xyz([0.3850649, 0.7168786, 0.0971045])],
    ['bXYZ', xyz([0.4360747, 0.2225045, 0.0139322])],
    ['rTRC', curve()],
    ['gTRC', curve()],
    ['bTRC', curve()],
    ['wtpt', xyz([0.9642, 1, 0.8249])],
  ];
  const dataStart = 128 + 4 + tags.length * 12;
  const profile = Buffer.alloc(
    dataStart + tags.reduce((size, [, data]) => size + data.length, 0),
  );
  profile.writeUInt32BE(profile.length, 0);
  profile.writeUInt32BE(0x02400000, 8);
  profile.write('mntr', 12);
  profile.write('RGB ', 16);
  profile.write('XYZ ', 20);
  [2000, 1, 1, 0, 0, 0].forEach((value, index) => profile.writeUInt16BE(value, 24 + index * 2));
  profile.write('acsp', 36);
  profile.write('APPL', 40);
  xyz([0.9642, 1, 0.8249]).copy(profile, 68, 8);
  profile.writeUInt32BE(tags.length, 128);
  let offset = dataStart;
  tags.forEach(([signature, data], index) => {
    const entry = 132 + index * 12;
    profile.write(signature, entry);
    profile.writeUInt32BE(offset, entry + 4);
    profile.writeUInt32BE(data.length, entry + 8);
    data.copy(profile, offset);
    offset += data.length;
  });
  const hex = `${profile.toString('hex')}>`;
  const content = '/Custom cs 1 0 0 scn 0 0 200 200 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /ColorSpace << /Custom [/ICCBased 5 0 R] >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /N 3 /Alternate /DeviceRGB /Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n${hex}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
