// Images are shrunk here before sending: the model scales anything larger down anyway (its cost
// tops out near 1024px), so 1600px keeps small print legible at a few hundred KB. Re-encoding as
// JPEG also drops EXIF data such as where a photo was taken, and turns whatever the browser can
// open (HEIC from a phone camera, GIF) into a format the server accepts.
const MAX_SIDE = 1600;
const QUALITY = 0.85;
export const MAX_ATTACHMENTS = 4;

export async function shrinkImage(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  // JPEG has no transparency; without a fill, transparent screenshots turn black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', QUALITY);
}

/** The image files among pasted or dropped items. */
export const imageFiles = (files: FileList | null | undefined): File[] =>
  [...(files ?? [])].filter((f) => f.type.startsWith('image/'));
