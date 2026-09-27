/**
 * Shrinks a photo in the browser before upload: phone cameras produce 5-10 MB
 * images, but a chat bubble needs ~1600 px on the long side. Output is always
 * a JPEG (re-encoding also drops embedded location data). Client-side only.
 */
const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;

export async function shrinkImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This photo could not be read. Use a JPEG, PNG or WebP image.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot process photos');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be processed'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}
