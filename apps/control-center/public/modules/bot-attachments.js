import { escapeHtml } from "../utils.js";
import { lucideIcon } from "../lucide.js";
import {
  ensureAttachmentContext,
  queueClipboardImageUploads,
  uploadClipboardImage,
  claimClipboardImage,
  MAX_ATTACHMENTS_PER_CONTEXT,
} from "./clipboard-attachments.js";

export function createBotAttachments({
  botState,
  state,
  byId,
  botActiveConversation,
  botConversationReadOnlyReason,
  syncBotComposerMode,
  toast,
  request,
}) {
  function botAttachmentContextKeyFor(conversation = botActiveConversation(), agentId = botState.agentId) {
    return conversation?.id
      ? `bot:conversation:${String(conversation.id)}`
      : `bot:member:${String(agentId || "unknown")}`;
  }

  function botMigrateAttachmentContext(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey || !state.attachmentContexts.has(fromKey)) return;
    const source = state.attachmentContexts.get(fromKey);
    const target = ensureAttachmentContext(state.attachmentContexts, toKey);
    botEnsureAttachmentPreviewMaps(source);
    botEnsureAttachmentPreviewMaps(target);
    for (const path of source.attachments || []) {
      if (!target.attachments.includes(path)) target.attachments.push(path);
      const preview = source.previews.get(String(path));
      if (preview && !target.previews.has(String(path))) target.previews.set(String(path), preview);
      else if (preview && target.previews.get(String(path)) !== preview) botReleaseAttachmentPreview(preview);
    }
    for (const item of source.uploads || []) {
      if (!target.uploads.includes(item)) target.uploads.push(item);
      const preview = source.previewUploads.get(String(item.id));
      if (preview && !target.previewUploads.has(String(item.id))) target.previewUploads.set(String(item.id), preview);
      else if (preview && target.previewUploads.get(String(item.id)) !== preview) botReleaseAttachmentPreview(preview);
    }
    state.attachmentContexts.delete(fromKey);
  }

  function botEnsureAttachmentPreviewMaps(context) {
    if (!context) return context;
    if (!(context.previews instanceof Map)) context.previews = new Map();
    if (!(context.previewUploads instanceof Map)) context.previewUploads = new Map();
    return context;
  }

  function botReleaseAttachmentPreview(previewUrl) {
    if (typeof previewUrl !== "string" || !previewUrl.startsWith("blob:")) return;
    globalThis.URL?.revokeObjectURL?.(previewUrl);
  }

  function botRemoveAttachmentPreview(context, path) {
    botEnsureAttachmentPreviewMaps(context);
    const key = String(path);
    const preview = context.previews.get(key);
    if (preview) botReleaseAttachmentPreview(preview);
    context.previews.delete(key);
  }

  function botRemoveUploadPreview(context, uploadId) {
    botEnsureAttachmentPreviewMaps(context);
    const key = String(uploadId);
    const preview = context.previewUploads.get(key);
    if (preview) botReleaseAttachmentPreview(preview);
    context.previewUploads.delete(key);
  }

  function botSafeAttachmentPreviewUrl(value) {
    const source = String(value || "");
    return /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);)/i.test(source) ? source : "";
  }

  function botOpenImagePreview(previewUrl, name, opener = null) {
    const source = botSafeAttachmentPreviewUrl(previewUrl);
    const dialog = byId("bot-image-preview-dialog");
    const image = byId("bot-image-preview-image");
    const title = byId("bot-image-preview-title");
    if (!source || !dialog || !image || typeof dialog.showModal !== "function") return false;
    const label = String(name || "附件图片");
    image.src = source;
    image.alt = label;
    if (title) title.textContent = label;
    botState.imagePreviewOpener = opener || document.activeElement;
    botState.imagePreviewOpenerUrl = source;
    if (!dialog.open) dialog.showModal();
    return true;
  }

  function botCloseImagePreview() {
    const dialog = byId("bot-image-preview-dialog");
    if (dialog?.open) dialog.close();
  }

  function botAttachmentContext() {
    return botEnsureAttachmentPreviewMaps(ensureAttachmentContext(state.attachmentContexts, botAttachmentContextKeyFor()));
  }

  function botAttachmentUploadInFlight() {
    return botAttachmentContext().uploads.some((item) => item.status === "uploading");
  }

  function botRenderAttachments() {
    const box = byId("bot-attach-chips");
    if (!box) return;
    const context = botAttachmentContext();
    botEnsureAttachmentPreviewMaps(context);
    box.hidden = !context.attachments.length && !context.uploads.length;
    box.setAttribute("aria-busy", context.uploads.some((item) => item.status === "uploading") ? "true" : "false");
    const saved = context.attachments.map((path, index) => {
      const name = String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
      const preview = botSafeAttachmentPreviewUrl(context.previews.get(String(path)));
      return `<span class="bot-attach-chip bot-attach-preview" title="${escapeHtml(path)}"><span class="bot-attach-preview-frame">${preview ? `<img class="bot-attach-preview-trigger" src="${escapeHtml(preview)}" alt="打开预览：${escapeHtml(name)}" loading="eager" tabindex="0" role="button" data-bot-preview="${escapeHtml(preview)}" data-bot-preview-name="${escapeHtml(name)}" />` : `<span class="bot-attach-fallback">${lucideIcon("image")}</span>`}<button class="bot-attach-remove" type="button" data-bot-detach="${index}" aria-label="移除图片 ${escapeHtml(name)}">${lucideIcon("x")}</button></span><span class="bot-attach-label">${escapeHtml(name)}</span></span>`;
    }).join("");
    const pending = context.uploads.map((item) => {
      const failed = item.status === "error";
      const preview = botSafeAttachmentPreviewUrl(context.previewUploads.get(String(item.id)));
      const stateLabel = failed ? item.error || "上传失败" : "正在上传";
      const statusIcon = lucideIcon(failed ? "triangle-alert" : "loader-circle");
      return `<span class="bot-attach-chip bot-attach-preview ${failed ? "is-error" : "is-uploading"}" title="${escapeHtml(stateLabel)}"><span class="bot-attach-preview-frame">${preview ? `<img class="bot-attach-preview-trigger" src="${escapeHtml(preview)}" alt="打开预览：${escapeHtml(item.name)}" loading="eager" tabindex="0" role="button" data-bot-preview="${escapeHtml(preview)}" data-bot-preview-name="${escapeHtml(item.name)}" />` : `<span class="bot-attach-fallback">${lucideIcon("image")}</span>`}<span class="bot-attach-status">${statusIcon}<span>${escapeHtml(failed ? "上传失败" : "上传中")}</span></span>${failed ? `<button class="bot-attach-remove" type="button" data-bot-upload-dismiss="${escapeHtml(item.id)}" aria-label="移除失败图片 ${escapeHtml(item.name)}">${lucideIcon("x")}</button>` : ""}</span><span class="bot-attach-label">${escapeHtml(item.name)}</span></span>`;
    }).join("");
    box.innerHTML = saved + pending;
    const readOnly = Boolean(botConversationReadOnlyReason());
    const attach = byId("bot-composer-form")?.querySelector("[data-bot-action='attach']");
    if (attach) attach.disabled = readOnly;
    syncBotComposerMode();
  }

  function botAttachmentSnapshot() {
    const key = botAttachmentContextKeyFor();
    const context = ensureAttachmentContext(state.attachmentContexts, key);
    return { key, sources: [...context.attachments], uploading: context.uploads.some((item) => item.status === "uploading") };
  }

  async function queueBotImages(files) {
    const readOnlyReason = botConversationReadOnlyReason();
    if (readOnlyReason) {
      toast(readOnlyReason, "info", 3600);
      return;
    }
    const key = botAttachmentContextKeyFor();
    const context = ensureAttachmentContext(state.attachmentContexts, key);
    botEnsureAttachmentPreviewMaps(context);
    const images = Array.from(files || []).filter((file) => String(file?.type || "").toLowerCase().startsWith("image/"));
    if (!images.length) return;
    const blockingUploads = context.uploads.filter((item) => item?.status !== "error").length;
    const capacity = Math.max(0, MAX_ATTACHMENTS_PER_CONTEXT - context.attachments.length - blockingUploads);
    const acceptedFiles = images.slice(0, capacity);
    const previewPlans = acceptedFiles.map((file, index) => ({
      file,
      id: `bot-upload-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      previewUrl: globalThis.URL?.createObjectURL?.(file) || "",
    }));
    const plansByFile = new Map();
    for (const plan of previewPlans) {
      if (!plansByFile.has(plan.file)) plansByFile.set(plan.file, []);
      plansByFile.get(plan.file).push(plan);
    }
    for (const plan of previewPlans) context.previewUploads.set(plan.id, plan.previewUrl);
    const outcome = await queueClipboardImageUploads({
      files: acceptedFiles,
      context,
      id: (index) => previewPlans[index]?.id || `bot-upload-${Date.now()}-${index}`,
      upload: async (file) => {
        const plan = plansByFile.get(file)?.shift();
        const result = await uploadClipboardImage(file, request);
        return plan?.previewUrl ? { ...result, previewUrl: plan.previewUrl } : result;
      },
      claim: (result) => claimClipboardImage(result, request),
      onChange: () => {
        if (botAttachmentContextKeyFor() === key) botRenderAttachments();
      },
    });
    if (outcome.saved) toast(`${outcome.saved} 张图片已附加`, "success", 2400);
    if (outcome.claimFailed) toast(`${outcome.claimFailed} 张图片已附加，但存储确认失败`, "warning", 6000);
    if (outcome.failed) toast(`${outcome.failed} 张图片附加失败，请查看附件状态`, "error", 5000);
    const rejected = images.length - acceptedFiles.length + outcome.rejected;
    if (rejected) toast(`当前对话最多附加 ${MAX_ATTACHMENTS_PER_CONTEXT} 个文件，已跳过 ${rejected} 个`, "warning", 5000);
  }

  return {
    botAttachmentContextKeyFor,
    botMigrateAttachmentContext,
    botEnsureAttachmentPreviewMaps,
    botReleaseAttachmentPreview,
    botRemoveAttachmentPreview,
    botRemoveUploadPreview,
    botSafeAttachmentPreviewUrl,
    botOpenImagePreview,
    botCloseImagePreview,
    botAttachmentContext,
    botAttachmentUploadInFlight,
    botRenderAttachments,
    botAttachmentSnapshot,
    queueBotImages,
  };
}
