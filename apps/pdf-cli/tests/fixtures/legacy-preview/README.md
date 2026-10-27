These are owned, generated fixtures. `create.ts` constructs a one-page P0 run and
0.6 preview with independently assigned source boxes, semantic HTML, and a tiny PNG.
No corpus PDFs, historical releases, Python environment, or model weights are
needed by npm tests. Mock PDF bytes are used only where inspection is injected.

The explicit Python unittest creates its own PDF with pypdf. The ignored local
four-rotation acceptance fixture is separately inspected against PDFium red pixels.
