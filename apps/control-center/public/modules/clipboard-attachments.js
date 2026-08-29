export const CLIPBOARD_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_CLIPBOARD_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_CONTEXT = 8;
export const MAX_CONCURRENT_CLIPBOARD_UPLOADS = 3;
let activeClipboardUploads = 0;
const clipboardUploadWaiters = [];

function clipboardError(message, code) {
  return Object.assign(new Error(message), { code });
}

async function withClipboardUploadSlot(operation) {
  if (activeClipboardUploads >= MAX_CONCURRENT_CLIPBOARD_UPLOADS) {
    await new Promise((resolve) => clipboardUploadWaiters.push(resolve));
  }
  activeClipboardUploads += 1;
  try {
    return await operation();
  } finally {
    activeClipboardUploads -= 1;
    clipboardUploadWaiters.shift()?.();
  }
}

export function clipboardImageFiles(clipboardData) {
  if (!clipboardData) return [];
  const files = [];
  const seen = new Set();
  const append = (file) => {
    if (!file || !String(file.type || "").toLowerCase().startsWith("image/") || seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };
  for (const item of Array.from(clipboardData.items || [])) {
    if (item?.kind === "file") append(item.getAsFile?.());
  }
  if (!files.length) for (const file of Array.from(clipboardData.files || [])) append(file);
  return files;
}

export function validateClipboardImage(file) {
  const mimeType = String(file?.type || "").toLowerCase();
  if (!CLIPBOARD_IMAGE_TYPES.includes(mimeType)) {
    throw clipboardError(`不支持的剪贴板图片格式：${mimeType || "未知格式"}`, "UNSUPPORTED_IMAGE_TYPE");
  }
  if (!Number.isFinite(file?.size) || file.size <= 0) throw clipboardError("剪贴板图片为空", "INVALID_IMAGE_DATA");
  if (file.size > MAX_CLIPBOARD_IMAGE_BYTES) throw clipboardError("剪贴板图片超过 5 MiB", "IMAGE_TOO_LARGE");
  return mimeType;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function clipboardFileDataUrl(file) {
  const mimeType = validateClipboardImage(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw clipboardError("剪贴板图片读取不完整", "INVALID_IMAGE_DATA");
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

export async function uploadClipboardImage(file, requestImpl) {
  if (typeof requestImpl !== "function") throw new TypeError("requestImpl must be a function");
  const dataUrl = await clipboardFileDataUrl(file);
  return requestImpl("/api/system/clipboard-image", { method: "POST", body: { dataUrl } });
}

export async function claimClipboardImage(uploadResult, requestImpl) {
  if (typeof requestImpl !== "function") throw new TypeError("requestImpl must be a function");
  if (!uploadResult?.path || !uploadResult?.claimToken) {
    throw clipboardError("剪贴板图片上传响应缺少确认信息", "UPLOAD_RESPONSE_INVALID");
  }
  return requestImpl("/api/system/clipboard-image/claim", {
    method: "POST",
    body: { path: uploadResult.path, claimToken: uploadResult.claimToken },
  });
}

export function attachmentContextKey({ runId = null, draftId } = {}) {
  if (runId) return `run:${runId}`;
  if (!draftId) throw new TypeError("draftId is required without a runId");
  return `draft:${draftId}`;
}

export function ensureAttachmentContext(contexts, key) {
  if (!(contexts instanceof Map)) throw new TypeError("contexts must be a Map");
  if (!contexts.has(key)) contexts.set(key, { attachments: [], uploads: [] });
  return contexts.get(key);
}

function preserveAttachmentPreview(context, item, result) {
  if (!result?.previewUrl || !(context?.previews instanceof Map)) return;
  context.previews.set(String(result.path), result.previewUrl);
  if (context.previewUploads instanceof Map) context.previewUploads.delete(String(item.id));
}

/**
 * 只消费本次请求已经快照并提交的附件；请求在途期间新加入的附件/上传不得被迟到响应抹掉。
 * 返回 true 表示上下文已经没有任何待提交内容，调用方可以安全删除 Map 项。
 */
export function consumeSubmittedAttachments(context, submittedPaths = []) {
  if (!context || !Array.isArray(context.attachments) || !Array.isArray(context.uploads)) {
    throw new TypeError("context must contain attachment and upload arrays");
  }
  const submitted = new Set((submittedPaths || []).map(String));
  if (submitted.size) {
    for (let index = context.attachments.length - 1; index >= 0; index -= 1) {
      if (submitted.has(String(context.attachments[index]))) context.attachments.splice(index, 1);
    }
  }
  return context.attachments.length === 0 && context.uploads.length === 0;
}

export function composerDraftHasActivity({ text = "", context = null } = {}) {
  return Boolean(
    String(text).trim()
    || context?.attachments?.length
    || context?.uploads?.length,
  );
}

export async function queueClipboardImageUploads({
  files,
  context,
  upload,
  claim = null,
  onChange = () => {},
  id = (index) => globalThis.crypto?.randomUUID?.() || `clipboard-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
  maxAttachments = MAX_ATTACHMENTS_PER_CONTEXT,
  maxConcurrent = MAX_CONCURRENT_CLIPBOARD_UPLOADS,
} = {}) {
  if (!context || !Array.isArray(context.attachments) || !Array.isArray(context.uploads)) {
    throw new TypeError("context must contain attachment and upload arrays");
  }
  if (typeof upload !== "function") throw new TypeError("upload must be a function");
  if (claim !== null && typeof claim !== "function") throw new TypeError("claim must be a function");
  const requested = Array.from(files || []);
  // 失败的上传仍以 chip 展示（可重试/手动清除），但不再占配额——
  // 否则 8 个配额被失败项耗尽后新粘贴全部被拒
  const blockingUploads = context.uploads.filter((item) => item?.status !== "error").length;
  const capacity = Math.max(0, maxAttachments - context.attachments.length - blockingUploads);
  const acceptedFiles = requested.slice(0, capacity);
  const uploads = acceptedFiles.map((file, index) => ({
    id: id(index),
    file,
    name: file.name || `剪贴板图片-${index + 1}`,
    status: "uploading",
    error: null,
  }));
  context.uploads.push(...uploads);
  if (uploads.length) onChange(context);

  let cursor = 0;
  let saved = 0;
  let claimFailed = 0;
  const worker = async () => {
    while (cursor < uploads.length) {
      const item = uploads[cursor++];
      try {
        const result = await withClipboardUploadSlot(() => upload(item.file));
        if (!result?.path) throw clipboardError("剪贴板图片上传响应缺少路径", "UPLOAD_RESPONSE_INVALID");
        const uploadIndex = context.uploads.indexOf(item);
        if (uploadIndex >= 0) context.uploads.splice(uploadIndex, 1);
        if (!context.attachments.includes(result.path)) context.attachments.push(result.path);
        preserveAttachmentPreview(context, item, result);
        onChange(context);
        if (claim) {
          try {
            await claim(result);
          } catch {
            claimFailed += 1;
          }
        }
        saved += 1;
      } catch (error) {
        item.status = "error";
        item.error = error.message || "剪贴板图片上传失败";
        item.code = error.code || null;
        item.usage = error.payload?.error?.usage || error.usage || null;
        item.limits = error.payload?.error?.limits || error.limits || null;
      } finally {
        onChange(context);
      }
    }
  };
  const workerCount = Math.min(Math.max(1, maxConcurrent), uploads.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    accepted: uploads.length,
    saved,
    failed: uploads.length - saved,
    rejected: requested.length - uploads.length,
    claimFailed,
  };
}

export async function retryQuotaClipboardImageUploads({
  context,
  upload,
  claim = null,
  onChange = () => {},
  maxConcurrent = MAX_CONCURRENT_CLIPBOARD_UPLOADS,
} = {}) {
  if (!context || !Array.isArray(context.attachments) || !Array.isArray(context.uploads)) {
    throw new TypeError("context must contain attachment and upload arrays");
  }
  if (typeof upload !== "function") throw new TypeError("upload must be a function");
  if (claim !== null && typeof claim !== "function") throw new TypeError("claim must be a function");
  const uploads = context.uploads.filter((item) =>
    item?.status === "error"
    && item.code === "CLIPBOARD_STORAGE_QUOTA_EXCEEDED"
    && item.file);
  for (const item of uploads) {
    item.status = "uploading";
    item.error = null;
    item.code = null;
    item.usage = null;
    item.limits = null;
  }
  if (uploads.length) onChange(context);

  let cursor = 0;
  let saved = 0;
  let claimFailed = 0;
  let quotaFailed = 0;
  let usage = null;
  let limits = null;
  const worker = async () => {
    while (cursor < uploads.length) {
      const item = uploads[cursor++];
      try {
        const result = await withClipboardUploadSlot(() => upload(item.file));
        if (!result?.path) throw clipboardError("剪贴板图片上传响应缺少路径", "UPLOAD_RESPONSE_INVALID");
        const uploadIndex = context.uploads.indexOf(item);
        if (uploadIndex >= 0) context.uploads.splice(uploadIndex, 1);
        if (!context.attachments.includes(result.path)) context.attachments.push(result.path);
        preserveAttachmentPreview(context, item, result);
        onChange(context);
        if (claim) {
          try {
            await claim(result);
          } catch {
            claimFailed += 1;
          }
        }
        saved += 1;
      } catch (error) {
        item.status = "error";
        item.error = error.message || "剪贴板图片上传失败";
        item.code = error.code || null;
        item.usage = error.payload?.error?.usage || error.usage || null;
        item.limits = error.payload?.error?.limits || error.limits || null;
        if (item.code === "CLIPBOARD_STORAGE_QUOTA_EXCEEDED") {
          quotaFailed += 1;
          usage = item.usage || usage;
          limits = item.limits || limits;
        }
      } finally {
        onChange(context);
      }
    }
  };
  const workerCount = Math.min(Math.max(1, maxConcurrent), uploads.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    attempted: uploads.length,
    saved,
    failed: uploads.length - saved,
    quotaFailed,
    claimFailed,
    usage,
    limits,
  };
}

export function bindClipboardImagePaste(input, onImages) {
  if (!input?.addEventListener || typeof onImages !== "function") return () => {};
  const handlePaste = (event) => {
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    // 图文混贴：图片走上传，文本按原生行为插回输入框——两者都不丢
    const text = event.clipboardData?.getData?.("text/plain") || "";
    if (text && typeof input.setRangeText === "function") {
      const start = input.selectionStart ?? input.value.length;
      input.setRangeText(text, start, input.selectionEnd ?? start, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    void onImages(files);
  };
  input.addEventListener("paste", handlePaste);
  return () => input.removeEventListener("paste", handlePaste);
}
