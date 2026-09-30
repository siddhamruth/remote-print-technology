/**
 * Browser-only: turn a selected photo + the customer's edits into the exact JPEG we print.
 *
 * CSS filters on the preview don't change the file, so without this step the print would
 * ignore every edit. Everything here runs locally in the customer's browser.
 */

const DPI = 300;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read this image. Try a JPEG or PNG.'));
    img.src = url;
  });
}

function supportsCanvasFilter() {
  const ctx = document.createElement('canvas').getContext('2d');
  return ctx && typeof ctx.filter === 'string';
}

/** Pixel-level fallback matching CSS brightness/contrast/saturate, for browsers without ctx.filter. */
function applyAdjustmentsManually(ctx, w, h, { brightness, contrast, saturation }) {
  const b = brightness / 100;
  const c = contrast / 100;
  const s = saturation / 100;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // CSS saturate() matrix
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * b;
    let g = d[i + 1] * b;
    let bl = d[i + 2] * b;
    r = (r - 127.5) * c + 127.5;
    g = (g - 127.5) * c + 127.5;
    bl = (bl - 127.5) * c + 127.5;
    d[i] = m[0] * r + m[1] * g + m[2] * bl;
    d[i + 1] = m[3] * r + m[4] * g + m[5] * bl;
    d[i + 2] = m[6] * r + m[7] * g + m[8] * bl;
  }
  ctx.putImageData(img, 0, 0);
}

/** Draw the photo with rotation/flip/adjustments onto a new canvas. */
function drawEdited(img, photo, maxEdge) {
  const rotation = ((photo.rotation || 0) % 360 + 360) % 360;
  const quarter = rotation === 90 || rotation === 270;
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = quarter ? h : w;
  canvas.height = quarter ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const adj = {
    brightness: photo.brightness ?? 100,
    contrast: photo.contrast ?? 100,
    saturation: photo.saturation ?? 100,
  };
  const needsAdjust = adj.brightness !== 100 || adj.contrast !== 100 || adj.saturation !== 100;
  const nativeFilter = supportsCanvasFilter();
  if (needsAdjust && nativeFilter) {
    ctx.filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturation}%)`;
  }

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (photo.flipped) ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  ctx.filter = 'none';

  if (needsAdjust && !nativeFilter) applyAdjustmentsManually(ctx, canvas.width, canvas.height, adj);
  return canvas;
}

/** Retro print: a 3x4 in card (photo + caption) centred on 4x6 in paper, with trim marks. */
function composePolaroid(edited, caption) {
  const page = document.createElement('canvas');
  page.width = 4 * DPI;
  page.height = 6 * DPI;
  const ctx = page.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, page.width, page.height);

  const cardW = 3 * DPI;
  const cardH = 4 * DPI;
  const x0 = (page.width - cardW) / 2;
  const y0 = (page.height - cardH) / 2;
  const border = 0.15 * DPI;
  const photoSize = cardW - 2 * border;

  // cover-crop the edited photo into a square
  const side = Math.min(edited.width, edited.height);
  const sx = (edited.width - side) / 2;
  const sy = (edited.height - side) / 2;
  ctx.drawImage(edited, sx, sy, side, side, x0 + border, y0 + border, photoSize, photoSize);

  if (caption) {
    ctx.fillStyle = '#222222';
    ctx.font = `${Math.round(0.16 * DPI)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const captionY = y0 + border + photoSize + (cardH - photoSize - border) / 2;
    ctx.fillText(String(caption).slice(0, 60), page.width / 2, captionY, cardW - 2 * border);
  }

  // light trim marks at the card corners
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 2;
  const mark = 0.12 * DPI;
  for (const [cx, cy] of [[x0, y0], [x0 + cardW, y0], [x0, y0 + cardH], [x0 + cardW, y0 + cardH]]) {
    ctx.beginPath();
    ctx.moveTo(cx - mark, cy);
    ctx.lineTo(cx - mark / 3, cy);
    ctx.moveTo(cx + mark / 3, cy);
    ctx.lineTo(cx + mark, cy);
    ctx.moveTo(cx, cy - mark);
    ctx.lineTo(cx, cy - mark / 3);
    ctx.moveTo(cx, cy + mark / 3);
    ctx.lineTo(cx, cy + mark);
    ctx.stroke();
  }
  return page;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), 'image/jpeg', quality);
  });
}

/**
 * @param {{ url: string, rotation?: number, flipped?: boolean, brightness?: number, contrast?: number, saturation?: number, caption?: string }} photo
 * @param {string} product  ProductType
 * @returns {Promise<Blob>} JPEG, well under Epson's 20 MB limit
 */
export async function renderPhotoForPrint(photo, product) {
  const img = await loadImage(photo.url);
  const isA4 = product === 'A4_PHOTO' || product === 'A4_DOCUMENT';
  const maxEdge = isA4 ? Math.round(11.7 * DPI) : 6 * DPI; // print size at 300 DPI
  const edited = drawEdited(img, photo, maxEdge);
  const out = product === 'POLAROID' ? composePolaroid(edited, photo.caption) : edited;

  let blob = await toJpeg(out, 0.92);
  if (blob.size > 19 * 1024 * 1024) blob = await toJpeg(out, 0.8);
  return blob;
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
