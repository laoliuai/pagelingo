import type { PdfSourceRef } from '@pagelingo/document-contracts';
import { Button } from '../../shared/ui/button';
export function SourceLocator({ references, onSelect, onClose }: { references: readonly PdfSourceRef[]; onSelect: (reference: PdfSourceRef) => void; onClose: () => void }) {
  return <div className="source-locator" role="group" aria-label="选择段落来源"><span>段落来源</span>{references.map((reference, i) => <Button key={i} onClick={() => onSelect(reference)}>来源 {i + 1} · 第 {reference.pageIndex + 1} 页</Button>)}<Button onClick={onClose}>关闭来源</Button></div>;
}
