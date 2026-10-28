import { ReaderWarnings } from '../reader/reader-warnings';
import type { BundleImport, PdfDocumentSummary, ReaderDescriptor, WebDocumentSummary } from '@pagelingo/document-contracts';

export const activeImport = (value?: BundleImport | null) =>
  !!value && ['created', 'receiving', 'validating'].includes(value.status);

export function translationLabel(status: NonNullable<PdfDocumentSummary['reader']>['translationStatus']) {
  return {
    'not-required': '无需翻译，原文可读',
    pending: '原文可读，译文待处理',
    partial: '部分译文可读，仍有文本未完成',
    completed: '译文已完成',
    failed: '原文可读，译文处理失败',
    cancelled: '原文可读，译文处理已取消',
  }[status];
}
export function ReaderStatus({ reader }: { reader: NonNullable<PdfDocumentSummary['reader']> | ReaderDescriptor }) {
  return (
    <div className="reader-status">
      <p>{translationLabel(reader.translationStatus)}</p>
      {reader.parseCoverage === 'partial' && <p>解析不完整，可能缺页或有未解析内容，请结合 PDF 原件阅读。</p>}
      <p className="muted">图片与区域图保留原文，图片内文字未必已翻译。</p>
      {'index' in reader && reader.index.generationKind === 'mock' && <p>模拟译文：仅供流程验收，不代表真实翻译结果。</p>}
      {'index' in reader && <ReaderWarnings warnings={[...reader.warnings, ...reader.index.warnings]} />}
    </div>
  );
}
export function ImportStatus({ result }: { result: BundleImport }) {
  const labels = {
    created: '等待上传阅读包…',
    receiving: '正在上传，等待服务器确认…',
    validating: '正在校验阅读包并保存，请稍候…',
    completed: '阅读包导入完成',
    cancelled: '导入已取消',
    failed: '阅读包导入失败',
  };
  return <><p role="status">{labels[result.status]}</p>{result.warnings?.map(warning => <p key={warning} role="status">{warning}</p>)}</>;
}

export function webSaveLabel(status: WebDocumentSummary['saveStatus']) {
  return { 'link-only': '仅保存链接', 'original-saved': '原文已保存', 'partial-resources': '原文已保存，部分资源缺失' }[status];
}
export function webProcessingLabel(status: WebDocumentSummary['processingStatus']) {
  return { 'link-only': '等待网页归档', 'fetch-queued': '等待获取原文', fetching: '正在获取原文', 'fetch-failed': '原文获取失败，链接已保留', 'awaiting-config': '原文可读，模型尚未配置', 'reader-ready': '归档正文可读' }[status];
}
