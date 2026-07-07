/**
 * Client-side thumbnail generation for launch token icons.
 *
 * We already upload the full image to Flap's IPFS pinning API for flap.sh,
 * but that CID isn't reliably fetchable from a browser (no public gateway
 * guarantee, CORS). So we also keep a small downscaled copy as a data URL
 * in our own `launched_tokens.metadata`, purely so our own tokens list/detail
 * pages can show the icon immediately without depending on IPFS.
 */

const MAX_DIMENSION = 160;
const JPEG_QUALITY = 0.82;

/** Reads a File and returns a small (<=160px) data URL, or null if it can't be decoded. */
export async function fileToThumbnailDataUrl(file: File): Promise<string | null> {
  try {
    const bitmap = await loadImage(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const preferPng = file.type === "image/png" || file.type === "image/svg+xml";
    return canvas.toDataURL(preferPng ? "image/png" : "image/jpeg", JPEG_QUALITY);
  } catch {
    return null;
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image."));
    };
    img.src = url;
  });
}
