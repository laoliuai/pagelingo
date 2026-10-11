import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Quote } from '@pagelingo/assistant-core';

export function QuoteCard({
  quote,
  onRemove,
  onReveal,
}: {
  quote: Quote;
  onRemove?: () => void;
  onReveal?: () => void;
}) {
  return (
    <details className="quote-card">
      <summary>
        <span className="quote-heading">
          <span>{quote.kind === 'code' ? '代码引用' : '文本引用'}</span>
          <span className="quote-count">{quote.text.length} 字符</span>
        </span>
        <span className={`quote-preview${quote.kind === 'code' ? ' quote-preview-code' : ''}`}>
          {quote.text}
        </span>
      </summary>
      <div className="quote-source">来源：{quote.label}</div>
      <pre>{quote.text}</pre>
      {quote.originalText && (
        <details>
          <summary>对应原文段落</summary>
          <pre>{quote.originalText}</pre>
        </details>
      )}
      <div className="quote-actions">
        {onReveal && quote.blockIds.length > 0 && (
          <button type="button" onClick={onReveal}>
            定位原文
          </button>
        )}
        {onRemove && (
          <button type="button" onClick={onRemove}>
            移除引用
          </button>
        )}
      </div>
    </details>
  );
}
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => {
          try {
            const parsed = new URL(url);
            return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? url : '';
          } catch {
            return '';
          }
        }}
        components={{
          img: ({ alt }) => <span className="hint">{alt ? `〔图片说明：${alt}〕` : '〔图片〕'}</span>,
          a: ({ children, href }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
