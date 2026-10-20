import type { ChatMessage } from '../../shared/contract';

/** A chat as Markdown: who said what, the commands the agent ran, the files attached. Tool output and thinking are left out. */
export function toMarkdown(title: string, directory: string, messages: readonly ChatMessage[]): string {
  const out: string[] = [`# ${title || 'Chat'}`, '', `_Exported from Pulse on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · worked in ${directory || '~'}_`, ''];
  for (const m of messages) {
    const text = m.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
      .trim();
    const files = m.parts.flatMap((p) => (p.type === 'file' ? [p.filename] : []));
    if (m.role === 'user') {
      if (!text && files.length === 0) continue;
      out.push('## You', '', text);
      if (files.length) out.push('', `_Attached: ${files.join(', ')}_`);
      out.push('');
      continue;
    }
    out.push('## Agent', '');
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim()) out.push(p.text.trim(), '');
      else if (p.type === 'tool') {
        const cmd = p.tool === 'bash' ? p.input.command : undefined;
        out.push(cmd ? `Ran \`${p.status === 'error' ? 'failed: ' : ''}${cmd.split('\n')[0]!.slice(0, 200)}\`` : `_${p.tool}: ${p.title}_`, '');
      }
    }
    if (m.error && m.error !== 'Stopped') out.push(`> ${m.error}`, '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Saves text as a file through a temporary link (no server round trip). */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return `${slug || 'chat'}-${new Date().toISOString().slice(0, 10)}.md`;
}
