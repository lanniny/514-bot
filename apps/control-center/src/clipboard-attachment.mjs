import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  clipboardStorageRoot,
  isManagedClipboardFileName,
  isManagedClipboardTemporaryFileName,
  pendingClipboardUploadPaths,
  registerPendingClipboardUpload,
  withClipboardLifecycleLock,
} from "./clipboard-lifecycle.mjs";

export const MAX_CLIPBOARD_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CLIPBOARD_IMAGE_REQUEST_BYTES = Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES / 3) * 4 + 4096;
export const MAX_CLIPBOARD_STORED_FILES = 256;
export const MAX_CLIPBOARD_STORAGE_BYTES = 512 * 1024 * 1024;
export const CLIPBOARD_CLEANUP_CONFIRMATION = "DELETE_UNREFERENCED_CLIPBOARD_IMAGES";

const MAX_IMAGE_DIMENSION = 32_768;
const MAX_IMAGE_PIXELS = 100_000_000;
const IMAGE_TYPES = Object.freeze({
  "image/png": { extension: "png" },
  "image/jpeg": { extension: "jpg" },
  "image/gif": { extension: "gif" },
  "image/webp": { extension: "webp" },
});
function attachmentError(message, code) {
  return Object.assign(new Error(message), { code });
}

function validDimensions(width, height) {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_IMAGE_DIMENSION
    && height <= MAX_IMAGE_DIMENSION
    && width * height <= MAX_IMAGE_PIXELS;
}

function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw attachmentError("clipboard image dataUrl is required", "INVALID_IMAGE_DATA");
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl);
  if (!match) throw attachmentError("clipboard image must be a base64 data URL", "INVALID_IMAGE_DATA");
  const mimeType = match[1].toLowerCase();
  if (!IMAGE_TYPES[mimeType]) throw attachmentError(`unsupported clipboard image type: ${mimeType}`, "UNSUPPORTED_IMAGE_TYPE");
  const encoded = match[2];
  if (!encoded || encoded.length % 4 !== 0) throw attachmentError("clipboard image base64 is malformed", "INVALID_IMAGE_DATA");
  if (encoded.length > Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES / 3) * 4) {
    throw attachmentError(`clipboard image exceeds ${MAX_CLIPBOARD_IMAGE_BYTES} bytes`, "IMAGE_TOO_LARGE");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw attachmentError("clipboard image base64 is malformed", "INVALID_IMAGE_DATA");
  if (!bytes.length) throw attachmentError("clipboard image is empty", "INVALID_IMAGE_DATA");
  if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw attachmentError(`clipboard image exceeds ${MAX_CLIPBOARD_IMAGE_BYTES} bytes`, "IMAGE_TOO_LARGE");
  }
  return { mimeType, bytes };
}

function inspectPng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  let offset = 8;
  let chunkIndex = 0;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    if (chunkLength > bytes.length - offset - 12) return null;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataOffset = offset + 8;
    const nextOffset = offset + 12 + chunkLength;
    if (chunkIndex === 0) {
      if (type !== "IHDR" || chunkLength !== 13) return null;
      if (!validDimensions(bytes.readUInt32BE(dataOffset), bytes.readUInt32BE(dataOffset + 4))) return null;
    } else if (type === "IHDR") {
      return null;
    }
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      return (chunkLength === 0 && hasImageData && nextOffset <= bytes.length) ? { length: nextOffset } : null;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  return null;
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      return (hasFrame && hasScan && offset <= bytes.length) ? { length: offset } : null;
    }
    if (marker === 0xd8) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || segmentLength > bytes.length - offset) return null;
    const segmentEnd = offset + segmentLength;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8 || !validDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return null;
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame) return null;
      hasScan = true;
      let scan = segmentEnd;
      let foundMarker = false;
      while (scan < bytes.length - 1) {
        if (bytes[scan] !== 0xff) {
          scan += 1;
          continue;
        }
        let markerOffset = scan + 1;
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= bytes.length) return null;
        const scanMarker = bytes[markerOffset];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          scan = markerOffset + 1;
          continue;
        }
        offset = scan;
        foundMarker = true;
        break;
      }
      if (!foundMarker) return null;
      continue;
    }
    offset = segmentEnd;
  }
  return null;
}

function skipGifSubBlocks(bytes, offset) {
  while (offset < bytes.length) {
    const size = bytes[offset++];
    if (size === 0) return offset;
    if (size > bytes.length - offset) return -1;
    offset += size;
  }
  return -1;
}

function inspectGif(bytes) {
  if (bytes.length < 15 || !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return null;
  if (!validDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) return null;
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
  if (offset >= bytes.length) return null;
  let hasImage = false;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) {
      return (hasImage && offset <= bytes.length) ? { length: offset } : null;
    }
    if (block === 0x21) {
      if (offset >= bytes.length) return null;
      offset = skipGifSubBlocks(bytes, offset + 1);
      if (offset < 0) return null;
      continue;
    }
    if (block !== 0x2c || offset + 9 > bytes.length) return null;
    const width = bytes.readUInt16LE(offset + 4);
    const height = bytes.readUInt16LE(offset + 6);
    if (!validDimensions(width, height)) return null;
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
    if (offset >= bytes.length) return null;
    offset = skipGifSubBlocks(bytes, offset + 1);
    if (offset < 0) return null;
    hasImage = true;
  }
  return null;
}

function webpImageDimensions(type, payload) {
  if (type === "VP8 ") {
    if (payload.length < 10 || !payload.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return null;
    return [payload.readUInt16LE(6) & 0x3fff, payload.readUInt16LE(8) & 0x3fff];
  }
  if (type === "VP8L") {
    if (payload.length < 5 || payload[0] !== 0x2f) return null;
    return [1 + payload[1] + ((payload[2] & 0x3f) << 8), 1 + (payload[2] >> 6) + (payload[3] << 2) + ((payload[4] & 0x0f) << 10)];
  }
  return null;
}

function webpExtendedHeader(payload) {
  if (payload.length !== 10 || payload[0] & 0xc1 || payload[1] || payload[2] || payload[3]) return null;
  return {
    animation: Boolean(payload[0] & 0x02),
    dimensions: [
      1 + payload[4] + (payload[5] << 8) + (payload[6] << 16),
      1 + payload[7] + (payload[8] << 8) + (payload[9] << 16),
    ],
  };
}

function validWebpAnimationFrame(payload, canvasDimensions) {
  if (payload.length < 30) return false;
  const frameOffset = [
    2 * (payload[0] + (payload[1] << 8) + (payload[2] << 16)),
    2 * (payload[3] + (payload[4] << 8) + (payload[5] << 16)),
  ];
  const frameDimensions = [
    1 + payload[6] + (payload[7] << 8) + (payload[8] << 16),
    1 + payload[9] + (payload[10] << 8) + (payload[11] << 16),
  ];
  if (!validDimensions(frameDimensions[0], frameDimensions[1])
    || payload[15] & 0xfc
    || frameOffset[0] + frameDimensions[0] > canvasDimensions[0]
    || frameOffset[1] + frameDimensions[1] > canvasDimensions[1]) return false;
  let offset = 16;
  let hasImageData = false;
  while (offset + 8 <= payload.length) {
    const type = payload.subarray(offset, offset + 4).toString("ascii");
    const size = payload.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (size > payload.length - dataOffset) return false;
    const nextOffset = dataOffset + size + (size % 2);
    if (nextOffset > payload.length) return false;
    const dimensions = webpImageDimensions(type, payload.subarray(dataOffset, dataOffset + size));
    if (["VP8 ", "VP8L"].includes(type) && !dimensions) return false;
    if (dimensions) {
      if (hasImageData) return false;
      if (!validDimensions(dimensions[0], dimensions[1])) return false;
      if (dimensions[0] !== frameDimensions[0] || dimensions[1] !== frameDimensions[1]) return false;
      hasImageData = true;
    }
    offset = nextOffset;
  }
  return hasImageData && offset === payload.length;
}

function inspectWebp(bytes) {
  if (bytes.length < 26 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const riffLength = bytes.readUInt32LE(4) + 8;
  if (riffLength > bytes.length) return null;
  let offset = 12;
  let chunkIndex = 0;
  let extendedHeader = null;
  let staticImageDimensions = null;
  let hasAnimationHeader = false;
  let animationFrames = 0;
  while (offset + 8 <= riffLength) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    if (size > riffLength - payloadStart) return null;
    const nextOffset = payloadStart + size + (size % 2);
    if (nextOffset > riffLength) return null;
    const payload = bytes.subarray(payloadStart, payloadStart + size);
    if (type === "VP8X") {
      if (chunkIndex !== 0 || extendedHeader) return null;
      extendedHeader = webpExtendedHeader(payload);
      if (!extendedHeader || !validDimensions(...extendedHeader.dimensions)) return null;
    }
    if (["VP8 ", "VP8L"].includes(type)) {
      const dimensions = webpImageDimensions(type, payload);
      if (!dimensions || !validDimensions(...dimensions) || staticImageDimensions || hasAnimationHeader || animationFrames) return null;
      if (!extendedHeader && chunkIndex !== 0) return null;
      if (extendedHeader?.animation) return null;
      if (extendedHeader && (dimensions[0] !== extendedHeader.dimensions[0] || dimensions[1] !== extendedHeader.dimensions[1])) return null;
      staticImageDimensions = dimensions;
    }
    if (type === "ANIM") {
      if (size !== 6 || !extendedHeader?.animation || hasAnimationHeader || staticImageDimensions || animationFrames) return null;
      hasAnimationHeader = true;
    }
    if (type === "ANMF") {
      if (!extendedHeader?.animation || !hasAnimationHeader || staticImageDimensions
        || !validWebpAnimationFrame(payload, extendedHeader.dimensions)) return null;
      animationFrames += 1;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  if (offset !== riffLength) return null;
  if (extendedHeader?.animation) {
    return (hasAnimationHeader && animationFrames > 0 && !staticImageDimensions) ? { length: riffLength } : null;
  }
  return (Boolean(staticImageDimensions) && !hasAnimationHeader && animationFrames === 0) ? { length: riffLength } : null;
}

export function inspectClipboardImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  const png = inspectPng(bytes);
  if (png) return { mimeType: "image/png", length: png.length };
  const jpeg = inspectJpeg(bytes);
  if (jpeg) return { mimeType: "image/jpeg", length: jpeg.length };
  const gif = inspectGif(bytes);
  if (gif) return { mimeType: "image/gif", length: gif.length };
  const webp = inspectWebp(bytes);
  if (webp) return { mimeType: "image/webp", length: webp.length };
  return null;
}

export function detectClipboardImageType(bytes) {
  return inspectClipboardImage(bytes)?.mimeType ?? null;
}

async function clipboardStorageUsage(root, storage) {
  const entries = await storage.readdir(root, { withFileTypes: true });
  let files = 0;
  let bytes = 0;
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(root, entry.name);
    const info = await storage.stat(path);
    files += 1;
    bytes += info.size;
    items.push({ name: entry.name, path, size: info.size, mtimeMs: Number(info.mtimeMs) || 0 });
  }
  return { files, bytes, items };
}

function normalizedPathKey(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pathInside(root, candidate) {
  const value = relative(root, candidate);
  return value && !value.startsWith("..") && !isAbsolute(value);
}

export async function cleanupClipboardImages({
  dataRoot,
  confirmation,
  protectedPaths = [],
  now = () => Date.now(),
  storage = { mkdir, readdir, rm, stat },
} = {}) {
  if (confirmation !== CLIPBOARD_CLEANUP_CONFIRMATION) {
    throw attachmentError("clipboard cleanup requires explicit confirmation", "CONFIRMATION_REQUIRED");
  }
  if (!dataRoot || (typeof protectedPaths !== "function" && !Array.isArray(protectedPaths))) {
    throw attachmentError("clipboard cleanup input is invalid", "VALIDATION_FAILED");
  }
  const root = clipboardStorageRoot(dataRoot);

  return withClipboardLifecycleLock(dataRoot, async () => {
    const currentProtectedPaths = typeof protectedPaths === "function" ? await protectedPaths() : protectedPaths;
    if (!Array.isArray(currentProtectedPaths) || currentProtectedPaths.length > 4096) {
      throw attachmentError("clipboard cleanup protected paths are invalid", "VALIDATION_FAILED");
    }
    const protectedSet = new Set([
      ...currentProtectedPaths,
      ...pendingClipboardUploadPaths({ dataRoot, now }),
    ]
      .map((path) => resolve(String(path || "")))
      .filter((path) => pathInside(root, path))
      .map(normalizedPathKey));
    await storage.mkdir(root, { recursive: true });
    const before = await clipboardStorageUsage(root, storage);
    let deletedFiles = 0;
    let freedBytes = 0;
    for (const item of [...before.items].sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      const managed = isManagedClipboardFileName(item.name) || isManagedClipboardTemporaryFileName(item.name);
      if (!managed || protectedSet.has(normalizedPathKey(item.path))) continue;
      await storage.rm(item.path, { force: true });
      deletedFiles += 1;
      freedBytes += item.size;
    }
    const after = await clipboardStorageUsage(root, storage);
    return {
      deletedFiles,
      freedBytes,
      usage: { files: after.files, bytes: after.bytes },
      limits: { files: MAX_CLIPBOARD_STORED_FILES, bytes: MAX_CLIPBOARD_STORAGE_BYTES },
    };
  });
}

export async function saveClipboardImage({
  dataUrl,
  dataRoot,
  now = () => new Date(),
  id = () => randomUUID(),
  claimId = () => randomUUID(),
  claimNow = () => Date.now(),
  storage = { mkdir, open, readdir, rename, rm, stat },
  limits = { files: MAX_CLIPBOARD_STORED_FILES, bytes: MAX_CLIPBOARD_STORAGE_BYTES },
} = {}) {
  if (!dataRoot) throw attachmentError("clipboard attachment data root is required", "INVALID_IMAGE_DATA");
  const { mimeType, bytes } = parseImageDataUrl(dataUrl);
  const imageInfo = inspectClipboardImage(bytes);
  if (!imageInfo) throw attachmentError("clipboard image structure is invalid or incomplete", "INVALID_IMAGE_DATA");
  const detectedType = imageInfo.mimeType;
  if (detectedType !== mimeType) {
    throw attachmentError(`clipboard image MIME ${mimeType} does not match file signature ${detectedType}`, "IMAGE_TYPE_MISMATCH");
  }
  const cleanBytes = imageInfo.length < bytes.length ? bytes.subarray(0, imageInfo.length) : bytes;

  const root = clipboardStorageRoot(dataRoot);
  const safeId = String(id()).replace(/[^a-z0-9-]/gi, "");
  if (!safeId) throw attachmentError("clipboard image id is invalid", "INVALID_IMAGE_DATA");
  const claimToken = String(claimId());
  if (!/^[a-z0-9_-]{16,128}$/i.test(claimToken)) {
    throw attachmentError("clipboard image claim id is invalid", "INVALID_IMAGE_DATA");
  }
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const name = `clipboard-${stamp}-${safeId}.${IMAGE_TYPES[mimeType].extension}`;
  const path = join(root, name);
  const temporaryPath = join(root, `.${name}.${process.pid}.tmp`);

  return withClipboardLifecycleLock(dataRoot, async () => {
    await storage.mkdir(root, { recursive: true });
    const usage = await clipboardStorageUsage(root, storage);
    if (usage.files >= limits.files || usage.bytes + cleanBytes.length > limits.bytes) {
      throw Object.assign(
        attachmentError("clipboard image storage quota is exhausted", "CLIPBOARD_STORAGE_QUOTA_EXCEEDED"),
        {
          usage: { files: usage.files, bytes: usage.bytes },
          limits: { files: limits.files, bytes: limits.bytes },
        },
      );
    }

    let handle = null;
    let ownsTemporaryPath = false;
    try {
      handle = await storage.open(temporaryPath, "wx", 0o600);
      ownsTemporaryPath = true;
      await handle.writeFile(cleanBytes);
      await handle.close();
      handle = null;
      await storage.rename(temporaryPath, path);
      ownsTemporaryPath = false;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (ownsTemporaryPath) await storage.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    const claim = registerPendingClipboardUpload({ dataRoot, path, claimToken, now: claimNow });
    return { path, name: basename(path), mimeType, size: cleanBytes.length, ...claim };
  });
}
