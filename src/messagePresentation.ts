import { chunks } from './common.js';

export function presentMessage(role: 'user' | 'assistant' | 'status', text: string): string[] {
  if (role !== 'user') return chunks(text);
  const prefix = '[VS Code User]\n';
  const parts = chunks(text, 3500 - Buffer.byteLength(prefix));
  if (parts.length === 1) return [prefix + parts[0]];
  const numbered = chunks(text, 3500 - Buffer.byteLength('[VS Code User 16/16]\n'));
  return numbered.map((part, index) => `[VS Code User ${index + 1}/${numbered.length}]\n${part}`);
}
