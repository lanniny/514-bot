export function skillPublicationStatus(result) {
  const publications = [];
  const warnings = [];
  const seen = new WeakSet();
  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return;
    seen.add(value);
    if (value.publication) publications.push(value.publication);
    if (Array.isArray(value.warnings)) warnings.push(...value.warnings);
    for (const child of Array.isArray(value) ? value : [value.item, value.result, value.items, value.results, value.imported]) visit(child, depth + 1);
  }
  visit(result);
  if (publications.some((p) => p.recoveryRequired) || warnings.some((w) => w?.code === "SKILL_TRANSACTION_RECOVERY_REQUIRED" || w?.message?.includes("SKILL_TRANSACTION_RECOVERY_REQUIRED"))) return { tone: "warning", message: "\u6280\u80fd\u53d1\u5e03\u9700\u8981\u6062\u590d\u6821\u9a8c\uff1b\u540e\u7eed\u5199\u5165\u5df2\u51bb\u7ed3" };
  if (publications.some((p) => p.committed !== true)) return { tone: "warning", message: "\u6280\u80fd\u53d1\u5e03\u7ed3\u679c\u5c1a\u672a\u786e\u8ba4" };
  if (publications.some((p) => p.cleanupPending) || warnings.some((w) => w?.message === "SKILL_CLEANUP_PENDING")) return { tone: "warning", message: "\u6280\u80fd\u5df2\u53d1\u5e03\uff0c\u65e7\u526f\u672c\u6e05\u7406\u5f85\u5b8c\u6210" };
  if (warnings.length) return { tone: "warning", message: `\u64cd\u4f5c\u5df2\u7ed3\u675f\uff0c${warnings.length} \u9879\u672a\u5b8c\u6210` };
  return null;
}

export function skillRecoveryReason(code) {
  return ({
    SKILL_RECOVERY_CHECK_REQUIRED: "等待检查当前文件与配置",
    SKILL_RECOVERY_LEGACY: "旧版记录缺少状态证明，需人工核对",
    SKILL_JOURNAL_INVALID: "发布记录损坏或格式不安全",
    SKILL_RECOVERY_PROOF_MISSING: "状态证明不完整，需人工核对",
    SKILL_RECOVERY_PATH_FORBIDDEN: "目录不属于当前 Skill 配置范围",
    SKILL_RECOVERY_MIXED_STATE: "文件与配置不一致，已保留现场",
    SKILL_PROOF_UNSAFE_FILE: "目录包含链接或特殊文件，需人工核对",
    SKILL_PROOF_LIMIT: "恢复材料超过自动检查上限",
    SKILL_PROOF_CHANGED: "检查期间文件发生变化，请重新检查",
    SKILL_RECOVERY_CHANGED: "检查后现场发生变化，请重新检查",
    SKILL_RECOVERY_PLAN_EXPIRED: "检查结果已过期，请重新检查",
    SKILL_RECOVERY_NOT_PENDING: "记录已结束，请刷新状态",
  })[code] || "恢复材料无法读取，写入保持冻结";
}
