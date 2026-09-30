/**
 * Browser-side: bake the customer's edits into real pixels before upload.
 *
 * CSS `filter` on an <img> only changes the preview. If you upload the original
 * File, the print will not match what the customer saw. Render to a canvas first.
 *
 * Runs entirely in the browser; the image never touches your server's disk.
 */

/**
 * @param {File|Blob} file
 * @param {{ brightness?: number, contrast?: number, saturation?: number, rotation?: 0|90|180|270, flipped?: boolean }} edits
 *        brightness/contrast/saturation in percent (100 = unchanged)
 * @param {{ maxEdge?: number, quality?: number }} [opts]  maxEdge caps size to stay under Epson's 20 MB limit
 * @returns {Promise<Blob>} JPEG
 */
export async function renderEditedImage(file, edits = {}, { maxEdge = 4800, quality = 0.95 } = {}) {
  const { brightness = 100, contrast = 100, saturation = 100, rotation = 0, flipped = false } = edits;
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const quarterTurn = rotation === 90 || rotation === 270;

  const canvas = new OffscreenCanvas(quarterTurn ? h : w, quarterTurn ? w : h);
  const ctx = canvas.getContext('2d');
  ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (flipped) ctx.scale(-1, 1);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

/**
 * Upload rendered photos one by one. Epson Connect accepts ONE file per job,
 * so the server issues one { jobId, uploadUri } per photo.
 *
 * Every step checks res.ok — a failed upload must stop the flow, never fall through to "print".
 */
export async function uploadAll(sessionToken, blobs, fetchImpl = fetch) {
  for (let i = 0; i < blobs.length; i++) {
    const res = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionToken)}/files/${i}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blobs[i],
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(`Photo ${i + 1} failed to upload: ${error || res.status}`);
    }
  }
}
