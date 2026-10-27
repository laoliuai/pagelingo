const explanations: Record<string, string> = {
  'source-binding-unavailable': '缺少可靠来源绑定，相关内容可能仅保留原文。',
  'source-identity-conflict': '来源身份不一致，相关内容按原文保留，请核对 PDF。',
  'source-evidence-conflict': '来源证据不一致，相关内容或定位已降级，请核对 PDF。',
  'unsupported-list-markers': '列表标记不受支持，列表结构可能已简化。',
};
export function ReaderWarnings({ warnings }: { warnings: readonly string[] }) {
  const retained = [...new Set(warnings)];
  if (!retained.length) return null;
  return <details className="reader-warnings"><summary>解析与阅读提示 · {retained.length} 条</summary>
    <ul aria-label="完整解析与阅读提示" tabIndex={0}>{retained.map(warning => {
      const explanation = explanations[warning.split(':', 1)[0]];
      return <li key={warning}>{explanation && <span>{explanation} </span>}<code>{warning}</code></li>;
    })}</ul>
  </details>;
}
