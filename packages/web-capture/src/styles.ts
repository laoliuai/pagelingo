const color = /^(?:[a-z]+|#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,% /]+\))$/i;
const size = /^(?:0|[0-9]{1,3}(?:\.[0-9]{1,3})?(?:px|em|rem|%))$/;
const rules = new Map<string, RegExp>([
  ['color', color], ['background-color', color], ['text-align', /^(left|right|center|justify)$/],
  ['font-weight', /^(normal|bold|[1-9]00)$/], ['font-style', /^(normal|italic|oblique)$/],
  ['font-size', size], ['line-height', /^(normal|[0-9](?:\.[0-9]{1,3})?|[0-9]{1,3}(?:px|%))$/],
  ['white-space', /^(normal|pre|pre-wrap|pre-line|break-spaces)$/], ['border-color', color],
  ['border-style', /^(none|solid|dashed|dotted|double)$/], ['border-width', size],
  ['text-decoration', /^(none|underline|line-through)$/], ['vertical-align', /^(baseline|sub|super|top|middle|bottom)$/],
]);
export function sanitizeStyle(input: string): string {
  return input.split(';').flatMap(part => {
    const colon = part.indexOf(':'); if (colon < 1) return [];
    const key = part.slice(0, colon).trim().toLowerCase(); const value = part.slice(colon + 1).trim();
    return rules.get(key)?.test(value) ? [`${key}:${value}`] : [];
  }).join(';');
}
