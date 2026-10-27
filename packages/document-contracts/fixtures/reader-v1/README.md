# Reader v1 fixtures

`source-ir.json` is a shape-valid, graph-valid PDF Reader fixture with repeated text at
separate canonical IDs, nested lists starting at 3, a prompt callout, inline math,
an image, code, display math, a rule and cross-page page-only references.
`translation.json` explicitly marks every text block and unit pending. These are
portable JSON fixtures; no PDF parser or real provider is invoked.

Hashes and byte counts are deliberate shape placeholders, not actual byte identities.
The fixture is not an importable complete bundle. `manifest.json` demonstrates the
manifest shape and normal package paths; later byte-level bundle tests create real files.

The independent rotation goldens use MediaBox `[0,0,400,500]`, CropBox
`[20,40,380,460]`, and the red PDF user-space rectangle `[60,100,140,200]`.
At rotations 0/180, display dimensions are 360×420 PDF points; at 90/270, 420×360.
`pdfToDisplay` maps original PDF user-space points to rotated effective-CropBox display
POINTS at scale 1 (PDF.js viewport.transform convention). Divide transformed x/y by
those display dimensions to obtain normalized bbox coordinates. Stored PdfSourceRef
bbox coordinates are already normalized and rotated; do not transform them again.
`rotation-goldens.json` stores the separately hand-derived normalized expected boxes.

`english-common-words.json` freezes lowercase common words for the later language
heuristic. Language classification and short Latin block inheritance are implemented
by the renderer adapter, not by these contract schemas.

`link-shapes.json` fixes the portable scheme/authority-shape policy separately from
WHATWG URL legality. Malformed authorities such as `https://[bad` deliberately pass
both Zod and JSON Schema shapes, then fail validateReaderGraph. Missing authorities,
unlisted schemes, whitespace and controls fail shape checks directly. Legal HTTP,
HTTPS, mailto, IPv6 and internationalized links pass both stages. Consumers must run
shape and graph validation before using the IR.
