import type { ChatAttachment } from '../../shared/contract';

/**
 * Files for a prompt, prepared in the browser: an image is shrunk (long side
 * 1568 px, JPEG) until it fits, a text file is read as UTF-8. Both end up as
 * base64 in the JSON body, which is capped (512 KB in all), so the budget is
 * small on purpose; the server checks type, content and size again.
 */

export interface Attachment extends ChatAttachment {
  readonly id: string;
  /** A data: URL for a thumbnail (images only; the CSP allows data:, not blob:). */
  readonly preview: string | null;
}

export const MAX_ATTACHMENTS = 4;
/** Base64 characters one file may take, and all together (server: chat.ts). */
export const ITEM_CHARS = 300_000;
export const TOTAL_CHARS = 340_000;
/** Text a prompt plus its files may reach (the server's body cap is 512 KB). */
export const BODY_CHARS = 480_000;
const TEXT_MAX_BYTES = 100_000;
const IMAGE_SIDE = 1568;

const TEXT_EXT = /\.(txt|md|markdown|log|json|jsonc|yaml|yml|toml|ini|conf|cfg|csv|tsv|sql|sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|go|rs|c|h|cpp|java|kt|rb|php|css|html|xml|service|timer|socket|diff|patch|dockerfile)$/i;
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/x-yaml', 'application/toml', 'application/x-sh']);

export const ACCEPT = 'image/*,text/*,.log,.md,.json,.yaml,.yml,.toml,.ini,.conf,.csv,.sql,.sh,.py,.js,.ts,.go,.rs,.service,.diff,.patch';

export class AttachError extends Error {}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new AttachError('could not read the file'));
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** An image small enough and in a format the server accepts is sent as it is; any other is redrawn as JPEG until it fits. */
async function prepareImage(file: File): Promise<{ mime: string; data: string }> {
  const asIs = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) && Math.ceil((file.size * 4) / 3) <= ITEM_CHARS;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new AttachError(`${file.name}: this browser cannot read that image (try a JPEG or PNG)`);
  }
  try {
    if (asIs && Math.max(bmp.width, bmp.height) <= IMAGE_SIDE) return { mime: file.type, data: await blobBase64(file) };
    let scale = Math.min(1, IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new AttachError('could not process the image');
      // JPEG has no transparency: a transparent PNG would turn black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      for (const q of [0.85, 0.72, 0.6, 0.45]) {
        const blob = await canvasBlob(canvas, q);
        if (!blob) continue;
        const data = await blobBase64(blob);
        if (data.length <= ITEM_CHARS) return { mime: 'image/jpeg', data };
      }
      scale *= 0.6;
    }
  } finally {
    bmp.close();
  }
  throw new AttachError(`${file.name} is too large to send`);
}

async function prepareText(file: File): Promise<{ mime: string; data: string }> {
  if (file.size > TEXT_MAX_BYTES) throw new AttachError(`${file.name}: text files up to ${TEXT_MAX_BYTES / 1000} KB (paste the part that matters)`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) throw new AttachError(`${file.name} is not a text file`);
  return { mime: 'text/plain', data: toBase64(bytes) };
}

let counter = 0;

/** Turns a picked, pasted or dropped file into an attachment, or throws an AttachError saying why not. */
export async function prepareFile(file: File): Promise<Attachment> {
  const isImage = file.type.startsWith('image/');
  const isText = file.type.startsWith('text/') || TEXT_TYPES.has(file.type) || TEXT_EXT.test(file.name);
  if (!isImage && !isText) throw new AttachError(`${file.name || 'That file'}: only images and text files`);
  const { mime, data } = isImage ? await prepareImage(file) : await prepareText(file);
  counter += 1;
  // A pasted screenshot has no useful name.
  const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${Date.now().toString(36)}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
  return { id: `att-${counter}`, name, mime, data, preview: isImage ? `data:${mime};base64,${data}` : null };
}

export function sizeLabel(a: Attachment): string {
  const bytes = Math.floor((a.data.length * 3) / 4);
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
