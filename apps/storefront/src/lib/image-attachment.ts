// Shrinks a customer's photo in the browser before it is sent.
//
// Why: the stock SimpleImageAttachmentAdapter sends the file exactly as it is, as a base64 data
// URL. A phone photo can be ~10 MB, which is ~13 MB once encoded — and Anthropic refuses an image over 10 MB, so the
// whole turn failed ("image exceeds 10 MB maximum") and no retry could ever help. A damage photo does not need 12
// megapixels: 1568px on the long edge is the size Anthropic itself scales to, and it keeps the request (and the case's
// transcript in the Escalation Desk, which embeds the photo) small.
import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import { generateId } from "@assistant-ui/react";
import { MAX_PHOTOS_PER_MESSAGE } from "../../../../shared/chat-limits";

const MAX_EDGE_PX = 1568;
// A photo already this small and this size is sent as it is — no re-encoding, no loss.
const KEEP_AS_IS_BYTES = 1_000_000;
const JPEG_QUALITY = 0.85;
// If the browser cannot decode the file at all (an unusual format) it is sent unchanged — but only when its base64
// form (~4/3 larger) is safely under the API's 10 MB limit.
const MAX_UNREADABLE_BYTES = 7 * 1024 * 1024;

/** What the customer is told when a photo can't be used (shown by the widget). The stated size is 7 MB, not the API's
 *  10 MB: the API counts the base64 form, which is a third larger than the file. */
const PHOTO_TOO_LARGE_MESSAGE = "That photo is over 7 MB and in a format we can't shrink. Please try a smaller one.";
const PHOTO_FORMAT_MESSAGE = "We can't read that file as a photo. Please try a JPG or PNG.";
/** The agent refuses a message with more photos than this, text and all, so the customer is stopped here, before Send. */
const TOO_MANY_PHOTOS_MESSAGE = `You can attach up to ${MAX_PHOTOS_PER_MESSAGE} photos in one message.`;

/** The size to draw an image at so its longer edge is at most `maxEdge`, never enlarging it. */
function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

type ApiImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** What the first bytes say the file is — the types the API accepts — or undefined. (Same test as the agent's
 *  chat-input.ts, which reads the type from the bytes again on the server.) */
function sniffImageType(b: Uint8Array): ApiImageType | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return undefined;
}

// `type` overrides the file's own label: the browser labels a file by its NAME, and a pasted image is always called
// image.png whatever bytes the clipboard held — a JPEG labelled PNG makes the API refuse the whole turn.
function readAsDataURL(blob: Blob, type?: string): Promise<string> {
  const labelled = type && blob.type !== type ? new Blob([blob], { type }) : blob;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the photo."));
    reader.readAsDataURL(labelled);
  });
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

// createImageBitmap applies the photo's EXIF rotation, so a portrait phone photo is not drawn sideways; the <img>
// route is the fallback for a browser without it.
async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The photo as a data: URL, shrunk to a size the API accepts, labelled with what it REALLY is. */
async function prepareImageForUpload(file: File): Promise<string> {
  const realType = sniffImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));

  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    // The browser can't open it, so it can't be shrunk: send it as it is only if it is a type the API takes and small
    // enough (base64 is a third larger than the file); otherwise say why not.
    if (realType && file.size <= MAX_UNREADABLE_BYTES) return readAsDataURL(file, realType);
    throw new Error(realType ? PHOTO_TOO_LARGE_MESSAGE : PHOTO_FORMAT_MESSAGE);
  }
  try {
    const target = fitWithin(decoded.width, decoded.height, MAX_EDGE_PX);
    const alreadySmall = target.width === decoded.width && target.height === decoded.height && file.size <= KEEP_AS_IS_BYTES;
    // Small enough to leave alone — but only when its real type is one the API accepts (anything else is re-encoded).
    if (alreadySmall && realType) return await readAsDataURL(file, realType);

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas");
    // JPEG has no transparency — a PNG's transparent areas would otherwise turn black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
    if (!blob) {
      if (realType && file.size <= MAX_UNREADABLE_BYTES) return await readAsDataURL(file, realType);
      throw new Error(PHOTO_FORMAT_MESSAGE);
    }
    return await readAsDataURL(blob, "image/jpeg");
  } finally {
    decoded.release();
  }
}

// Same shape as the library's SimpleImageAttachmentAdapter (add → pending, send → the image part), with the photo
// shrunk as soon as it is attached — so a photo that can't be used is refused HERE, with a message, rather than
// failing silently when the customer presses Send. `onProblem` receives that message (null clears it).
// What the composer's chip calls the photo. A pasted image has no real name — the browser calls every one of them
// `image.png` (whatever the bytes are) — so that tells the customer nothing; say what it is and how big. A file chosen
// from the device keeps its own name (IMG_4021.jpg).
function attachmentLabel(fileName: string, preparedDataUrl: string): string {
  if (fileName && !/^image\.(png|jpe?g|gif|webp)$/i.test(fileName)) return fileName;
  const base64 = preparedDataUrl.slice(preparedDataUrl.indexOf(",") + 1);
  const kb = Math.max(1, Math.round((base64.length * 3) / 4 / 1024));
  return `Pasted photo (${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`})`;
}

export class ResizedImageAttachmentAdapter implements AttachmentAdapter {
  // Called by the chat library through the AttachmentAdapter interface, not by our own code.
  // fallow-ignore-next-line unused-class-member
  accept = "image/*";
  private readonly prepared = new Map<string, string>();
  // Photos attached to the message being written. Counted the moment add is called, not when the photo is ready, so six
  // photos pasted at once are still held to the limit.
  private active = 0;

  constructor(private readonly onProblem?: (message: string | null) => void) {}

  // Called by the chat library through the AttachmentAdapter interface, not by our own code.
  // fallow-ignore-next-line unused-class-member
  async add(state: { file: File }): Promise<PendingAttachment> {
    this.onProblem?.(null);
    if (this.active >= MAX_PHOTOS_PER_MESSAGE) {
      this.onProblem?.(TOO_MANY_PHOTOS_MESSAGE);
      throw new Error(TOO_MANY_PHOTOS_MESSAGE);
    }
    this.active++;
    let dataUrl: string;
    try {
      dataUrl = await prepareImageForUpload(state.file);
    } catch (error) {
      this.active--;
      this.onProblem?.(error instanceof Error ? error.message : PHOTO_FORMAT_MESSAGE);
      throw error;
    }
    const id = generateId();
    this.prepared.set(id, dataUrl);
    return {
      id,
      type: "image",
      name: attachmentLabel(state.file.name, dataUrl),
      // The library builds the request's file part from THIS label, not from the data URL — so it must be the real
      // type (read off the prepared photo), or a pasted JPEG still goes out as image/png.
      contentType: /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? state.file.type,
      file: state.file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  // Called by the chat library through the AttachmentAdapter interface, not by our own code.
  // fallow-ignore-next-line unused-class-member
  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const image = this.prepared.get(attachment.id) ?? (await prepareImageForUpload(attachment.file));
    if (this.prepared.delete(attachment.id)) this.active--;
    return { ...attachment, status: { type: "complete" }, content: [{ type: "image", image }] };
  }

  // Called by the chat library through the AttachmentAdapter interface, not by our own code.
  // fallow-ignore-next-line unused-class-member
  async remove(attachment: { id: string }): Promise<void> {
    if (this.prepared.delete(attachment.id)) this.active--;
  }
}
