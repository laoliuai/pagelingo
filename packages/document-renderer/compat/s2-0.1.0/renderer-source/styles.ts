import type { ReaderBinding, ReaderNode } from '@pagelingo/document-contracts';
/** Values are enums/strict hex from the contracts; caller text never enters CSS. */
export function bindingStyle(binding: ReaderBinding | undefined): string {
  if (binding?.kind !== 'style') return '';
  const declarations: string[] = [];
  if (binding.align && ['left', 'center', 'right', 'justify'].includes(binding.align)) declarations.push(`text-align:${binding.align}`);
  if (binding.monospace) declarations.push('font-family:monospace');
  if (binding.color && /^#[0-9a-f]{6}$/.test(binding.color)) declarations.push(`color:${binding.color}`);
  if (binding.backgroundColor && /^#[0-9a-f]{6}$/.test(binding.backgroundColor)) declarations.push(`background-color:${binding.backgroundColor}`);
  return declarations.length ? ` style="${declarations.join(';')}"` : '';
}
export function nodeStyle(node: ReaderNode): string {
  return node.presentation?.align ? ` style="text-align:${node.presentation.align}"` : '';
}
