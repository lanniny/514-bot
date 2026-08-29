import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  attachmentContextKey,
  bindClipboardImagePaste,
  claimClipboardImage,
  clipboardFileDataUrl,
  clipboardImageFiles,
  composerDraftHasActivity,
  consumeSubmittedAttachments,
  ensureAttachmentContext,
  MAX_CONCURRENT_CLIPBOARD_UPLOADS,
  queueClipboardImageUploads,
  retryQuotaClipboardImageUploads,
  uploadClipboardImage,
} from "../public/modules/clipboard-attachments.js";

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngFile = {
  name: "clipboard.png",
  type: "image/png",
  size: pngBytes.byteLength,
  arrayBuffer: async () => pngBytes.buffer.slice(0),
};

test("clipboardImageFiles extracts image file items without consuming text-only paste", () => {
  const text = { kind: "string", type: "text/plain", getAsFile: () => null };
  const image = { kind: "file", type: "image/png", getAsFile: () => pngFile };
  assert.deepEqual(clipboardImageFiles({ items: [text, image] }), [pngFile]);
  assert.deepEqual(clipboardImageFiles({ items: [text], files: [] }), []);
});

test("clipboard image upload sends one bounded data URL to the controlled endpoint", async () => {
  const calls = [];
  const result = await uploadClipboardImage(pngFile, async (path, options) => {
    calls.push({ path, options });
    return { path: "C:/data/clipboard.png" };
  });
  assert.equal(result.path, "C:/data/clipboard.png");
  assert.equal(calls[0].path, "/api/system/clipboard-image");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body.dataUrl, await clipboardFileDataUrl(pngFile));
  await assert.rejects(
    () => uploadClipboardImage({ ...pngFile, type: "image/svg+xml" }, async () => assert.fail("unsupported image reached the API")),
    { code: "UNSUPPORTED_IMAGE_TYPE" },
  );
});

test("clipboard image claim releases the server lease with the returned capability", async () => {
  const calls = [];
  const uploadResult = { path: "C:/data/clipboard.png", claimToken: "claim-token-123456789" };
  await claimClipboardImage(uploadResult, async (path, options) => {
    calls.push({ path, options });
    return { claimed: true, path: uploadResult.path };
  });
  assert.deepEqual(calls, [{
    path: "/api/system/clipboard-image/claim",
    options: {
      method: "POST",
      body: uploadResult,
    },
  }]);
});

test("paste binding prevents default only when an image is present", async () => {
  const listeners = new Map();
  const input = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const received = [];
  const unbind = bindClipboardImagePaste(input, async (files) => received.push(files));
  let prevented = false;
  listeners.get("paste")({
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pngFile }] },
    preventDefault: () => { prevented = true; },
  });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.deepEqual(received, [[pngFile]]);

  prevented = false;
  listeners.get("paste")({ clipboardData: { items: [] }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  unbind();
  assert.equal(listeners.has("paste"), false);
});

test("submitted attachment consumption preserves files added while the request was in flight", () => {
  const context = { attachments: ["old.png", "new.png"], uploads: [{ id: "upload-new" }] };
  assert.equal(consumeSubmittedAttachments(context, ["old.png"]), false);
  assert.deepEqual(context.attachments, ["new.png"]);
  assert.deepEqual(context.uploads, [{ id: "upload-new" }]);
  assert.equal(consumeSubmittedAttachments(context, ["new.png"]), false);
  context.uploads.splice(0);
  assert.equal(consumeSubmittedAttachments(context, []), true);
});

test("clipboard upload completion stays bound to the captured composer context", async () => {
  const contexts = new Map();
  const draft = ensureAttachmentContext(contexts, attachmentContextKey({ draftId: "draft-a" }));
  const run = ensureAttachmentContext(contexts, attachmentContextKey({ runId: "run-b", draftId: "unused" }));
  let resolveUpload;
  const uploadReady = new Promise((resolveUploadPromise) => { resolveUpload = resolveUploadPromise; });
  const changed = [];
  const pending = queueClipboardImageUploads({
    files: [pngFile],
    context: draft,
    upload: () => uploadReady,
    claim: async (result) => {
      assert.equal(result.claimToken, "draft-claim-token-123456");
      assert.deepEqual(draft.attachments, ["C:/data/draft-a.png"]);
      assert.deepEqual(draft.uploads, []);
    },
    onChange: (context) => changed.push(context),
    id: () => "owned-upload",
  });
  assert.equal(draft.uploads.length, 1);
  assert.deepEqual(run, { attachments: [], uploads: [] });

  resolveUpload({ path: "C:/data/draft-a.png", claimToken: "draft-claim-token-123456" });
  const outcome = await pending;
  assert.deepEqual(outcome, { accepted: 1, saved: 1, failed: 0, rejected: 0, claimFailed: 0 });
  assert.deepEqual(draft.attachments, ["C:/data/draft-a.png"]);
  assert.deepEqual(run, { attachments: [], uploads: [] }, "late upload leaked into the newly selected run");
  assert.ok(changed.every((context) => context === draft));
});

test("composer draft activity blocks late automatic run selection", () => {
  assert.equal(composerDraftHasActivity(), false);
  assert.equal(composerDraftHasActivity({ text: "  " }), false);
  assert.equal(composerDraftHasActivity({ text: "新任务" }), true);
  assert.equal(composerDraftHasActivity({ context: { attachments: ["C:/data/draft.png"], uploads: [] } }), true);
  assert.equal(composerDraftHasActivity({ context: { attachments: [], uploads: [{ status: "uploading" }] } }), true);
});

test("clipboard upload queue enforces per-context capacity and concurrency", async () => {
  const context = { attachments: Array.from({ length: 6 }, (_, index) => `existing-${index}`), uploads: [] };
  let active = 0;
  let peak = 0;
  const files = Array.from({ length: 5 }, (_, index) => ({ ...pngFile, name: `paste-${index}.png` }));
  const outcome = await queueClipboardImageUploads({
    files,
    context,
    upload: async (file) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolveUpload) => setTimeout(resolveUpload, 2));
      active -= 1;
      return { path: `C:/data/${file.name}` };
    },
  });
  assert.deepEqual(outcome, { accepted: 2, saved: 2, failed: 0, rejected: 3, claimFailed: 0 });
  assert.ok(peak <= MAX_CONCURRENT_CLIPBOARD_UPLOADS);
  assert.equal(context.attachments.length, 8);
});

test("clipboard upload limiter stays global across overlapping paste queues", async () => {
  const contexts = [
    { attachments: [], uploads: [] },
    { attachments: [], uploads: [] },
  ];
  let active = 0;
  let peak = 0;
  const upload = async (file) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolveUpload) => setTimeout(resolveUpload, 4));
    active -= 1;
    return { path: `C:/data/${file.name}` };
  };
  await Promise.all(contexts.map((context, contextIndex) => queueClipboardImageUploads({
    files: Array.from({ length: 4 }, (_, index) => ({ ...pngFile, name: `paste-${contextIndex}-${index}.png` })),
    context,
    upload,
  })));
  assert.ok(peak <= MAX_CONCURRENT_CLIPBOARD_UPLOADS, `global upload peak was ${peak}`);
  assert.deepEqual(contexts.map((context) => context.attachments.length), [4, 4]);
});

test("clipboard upload queue preserves quota error codes for the cleanup affordance", async () => {
  const context = { attachments: [], uploads: [] };
  await queueClipboardImageUploads({
    files: [pngFile],
    context,
    upload: async () => {
      throw Object.assign(new Error("storage quota exhausted"), { code: "CLIPBOARD_STORAGE_QUOTA_EXCEEDED" });
    },
    id: () => "quota-upload",
  });
  assert.deepEqual(context.uploads.map(({ id, status, code }) => ({ id, status, code })), [{
    id: "quota-upload",
    status: "error",
    code: "CLIPBOARD_STORAGE_QUOTA_EXCEEDED",
  }]);
});

test("clipboard upload keeps the saved attachment and reports a failed lease claim", async () => {
  const context = { attachments: [], uploads: [] };
  const outcome = await queueClipboardImageUploads({
    files: [pngFile],
    context,
    upload: async () => ({ path: "C:/data/claim-failed.png", claimToken: "failed-claim-token-123456" }),
    claim: async () => { throw new Error("claim transport failed"); },
  });
  assert.deepEqual(outcome, { accepted: 1, saved: 1, failed: 0, rejected: 0, claimFailed: 1 });
  assert.deepEqual(context.attachments, ["C:/data/claim-failed.png"]);
  assert.deepEqual(context.uploads, []);
});

test("clipboard upload carries an optional preview URL without changing the submitted path contract", async () => {
  const context = {
    attachments: [],
    uploads: [],
    previews: new Map(),
    previewUploads: new Map([["preview-upload", "blob:pending-preview"]]),
  };
  await queueClipboardImageUploads({
    files: [pngFile],
    context,
    id: () => "preview-upload",
    upload: async () => ({ path: "C:/data/preview.png", previewUrl: "blob:saved-preview" }),
  });
  assert.deepEqual(context.attachments, ["C:/data/preview.png"]);
  assert.equal(context.previews.get("C:/data/preview.png"), "blob:saved-preview");
  assert.equal(context.previewUploads.has("preview-upload"), false);
});

test("quota retry reuses the original File and preserves it when capacity is still exhausted", async () => {
  const context = { attachments: [], uploads: [] };
  const quotaError = (files) => Object.assign(new Error("storage quota exhausted"), {
    code: "CLIPBOARD_STORAGE_QUOTA_EXCEEDED",
    payload: { error: { usage: { files, bytes: 100 }, limits: { files: 256, bytes: 200 } } },
  });
  await queueClipboardImageUploads({
    files: [pngFile],
    context,
    upload: async () => { throw quotaError(256); },
    id: () => "quota-retry-upload",
  });
  const originalFile = context.uploads[0].file;
  const failed = await retryQuotaClipboardImageUploads({
    context,
    upload: async (file) => {
      assert.equal(file, originalFile);
      throw quotaError(256);
    },
  });
  assert.deepEqual(failed, {
    attempted: 1,
    saved: 0,
    failed: 1,
    quotaFailed: 1,
    claimFailed: 0,
    usage: { files: 256, bytes: 100 },
    limits: { files: 256, bytes: 200 },
  });
  assert.equal(context.uploads[0].file, originalFile);
  assert.equal(context.uploads[0].status, "error");

  const recovered = await retryQuotaClipboardImageUploads({
    context,
    upload: async (file) => {
      assert.equal(file, originalFile);
      return { path: "C:/data/recovered.png" };
    },
  });
  assert.deepEqual(recovered, {
    attempted: 1,
    saved: 1,
    failed: 0,
    quotaFailed: 0,
    claimFailed: 0,
    usage: null,
    limits: null,
  });
  assert.deepEqual(context.uploads, []);
  assert.deepEqual(context.attachments, ["C:/data/recovered.png"]);
});

test("composer wires image paste into attachment state and blocks send while upload is active", async () => {
  const publicRoot = resolve(import.meta.dirname, "../public");
  const [app, state, styles] = await Promise.all([
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "state.js"), "utf8"),
    readFile(resolve(publicRoot, "styles.css"), "utf8"),
  ]);
  assert.match(app, /bindClipboardImagePaste\(taskInput, queueClipboardImages\)/);
  assert.match(app, /bindClipboardImagePaste\(byId\("mission-side-chat-input"\), queueClipboardImages\)/);
  assert.match(app, /attachmentUploadInFlight\(\)/);
  assert.match(app, /composerSubmitInFlight \|\| attachmentUploadInFlight\(\)/);
  assert.match(app, /box\.innerHTML = saved \+ pending;\s*syncSubmitButtonMode\(\);\s*syncSideChatTarget\(\);/);
  assert.match(app, /queueClipboardImageUploads\(\{/);
  assert.match(app, /claim:\s*\(result\) => claimClipboardImage\(result, request\)/);
  assert.match(app, /retryQuotaClipboardImageUploads\(\{/);
  assert.match(app, /claim:\s*\(uploadResult\) => claimClipboardImage\(uploadResult, request\)/);
  assert.match(app, /currentAttachmentContextKey\(\) === contextKey/);
  assert.match(app, /composerDraftHasActivity\(\{[\s\S]*text: elements\["task-input"\]\?\.value,[\s\S]*context: draftContext/);
  assert.match(app, /后台自动选中旧 run[\s\S]*state\.selectionClearedByUser = true;/);
  assert.match(app, /consumeSubmittedAttachmentContext\(attachmentContextKeyAtSubmit, submissionSources\)/);
  assert.match(app, /if \(submissionSources\.length\) message\.sources = submissionSources;/);
  assert.match(app, /request\(`\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}\/messages`/);
  assert.doesNotMatch(app, /request\(`\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}\/sources`/);
  assert.match(app, /item\.code === "CLIPBOARD_STORAGE_QUOTA_EXCEEDED"/);
  assert.match(app, /data-clipboard-cleanup/);
  assert.match(app, /confirmAction\(\{[\s\S]*confirmationText: "清理剪贴板"/);
  assert.match(app, /\/api\/system\/clipboard-images\/cleanup/);
  assert.match(app, /protectedPaths = \[\.\.\.state\.attachmentContexts\.values\(\)\]/);
  assert.match(app, /其他浏览器页面尚未提交的附件不在保护范围/);
  assert.match(app, /清理后仍超出剪贴板配额/);
  assert.match(app, /已清理[\s\S]*formatConfigBytes\(result\.freedBytes/);
  assert.doesNotMatch(app, /\bformatBytes\(/);
  assert.match(state, /composerDraftId:/);
  assert.match(state, /attachmentContexts:\s*new Map\(\)/);
  assert.match(styles, /\.attach-chip > span\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;/);
});

test("Bot composer accepts paste, drop, file selection, and isolates attachments per conversation", async () => {
  const [app, html, css] = await Promise.all([
    readFile(resolve(import.meta.dirname, "../public/app.js"), "utf8"),
    readFile(resolve(import.meta.dirname, "../public/index.html"), "utf8"),
    readFile(resolve(import.meta.dirname, "../public/forge/bot-shell.css"), "utf8"),
  ]);
  assert.match(app, /function botAttachmentContextKeyFor\(conversation = botActiveConversation\(\), agentId = botState\.agentId\)/);
  assert.match(app, /return conversation\?\.id\s*\? `bot:conversation:\$\{String\(conversation\.id\)\}`/);
  assert.match(app, /bindClipboardImagePaste\(botInput, queueBotImages\)/);
  assert.match(app, /botInput\?\.addEventListener\("dragover"/);
  assert.match(app, /botInput\?\.addEventListener\("drop"/);
  assert.match(app, /bot-attachment-file.*change/);
  assert.match(app, /bot-attach-chips.*data-bot-detach/s);
  assert.match(app, /if \(botAttachmentUploadInFlight\(\)\)/);
  assert.match(app, /botEnsureAttachmentPreviewMaps\(context\)/);
  assert.match(app, /botSafeAttachmentPreviewUrl/);
  assert.match(app, /class="bot-attach-preview-frame"/);
  assert.match(app, /<img class="bot-attach-preview-trigger" src="\$\{escapeHtml\(preview\)\}/);
  assert.match(app, /botRemoveAttachmentPreview\(context, path\)/);
  assert.match(app, /function botOpenImagePreview\(previewUrl, name/);
  assert.match(app, /dialog\.showModal\(\)/);
  assert.match(app, /data-bot-preview/);
  assert.match(app, /bot-image-preview-dialog.*addEventListener\("close"/);
  assert.match(app, /imagePreviewOpenerUrl/);
  assert.match(app, /find\(\(element\) => element\.dataset\.botPreview === openerUrl\)/);
  assert.match(app, /setTimeout\(restoreFocus, 0\)/);
  assert.match(app, /botOpenImagePreview\(preview\.dataset\.botPreview/);
  assert.match(html, /id="bot-attachment-file"[^>]+accept="image\/(png|jpeg|gif|webp)/);
  assert.match(html, /id="bot-attach-chips"/);
  assert.match(html, /id="bot-image-preview-dialog"[^>]+aria-labelledby="bot-image-preview-title"/);
  assert.match(html, /id="bot-image-preview-image"/);
  assert.match(css, /\.bot-attach-chip/);
  assert.match(css, /\.bot-attach-preview-frame[\s\S]*aspect-ratio:\s*1/);
  assert.match(css, /\.bot-attach-preview-frame img[\s\S]*object-fit:\s*cover/);
  assert.match(css, /\.bot-attach-remove[\s\S]*border-radius:\s*50%/);
  assert.match(css, /\.bot-image-preview-dialog::backdrop/);
  assert.match(css, /\.bot-image-preview-body img[\s\S]*object-fit:\s*contain/);
});
