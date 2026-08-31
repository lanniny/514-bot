/**
 * W3.14 Adapter SDK：新 CLI 接入的契约文档、模板校验与接入清单。
 *
 * 一个可执行的 adapter 由三件事组成（三者必须同步登记，缺一即"半接入"——
 * 参考样例：opencode-cli 已注册工厂但无 binding，UI 不可见）：
 *
 *   1. 实现文件  src/adapters/<cli>.mjs
 *      工厂签名（见 index.mjs FACTORIES）：({ profile, eventStore, cwd, approvalResolver,
 *      providerStore, onProviderDegraded }) => adapter 实例。
 *      实例契约（Orchestrator 会调用，缺失会在对应路径 fail-closed 抛错而非静默）：
 *        send(input)          必需——执行一轮；输入含 prompt/cwd/model/effort/permissionMode/
 *                             onSessionStarted/onTurnSubmitting/onTurnAccepted 钩子；
 *                             返回 { sessionId, text, protocol, tokens?, costUsd? }，
 *                             失败抛 Error 并尽量携带 code / costUsd / tokens / safeToFallback
 *        compactThread()      可选——/compact 原生命令通道
 *        close()              必需——控制面关闭时释放子进程/连接
 *
 *   2. 模板      src/adapters/manifest.mjs 的 ADAPTER_TEMPLATES 条目（validateAdapterTemplate 校验）
 *   3. 绑定      同文件 ADAPTER_BINDINGS 条目（profileId = UI 的 runtime profile id）
 *
 * 新 CLI 接入清单（按序）：
 *   [ ] 1. 实现工厂 + send/close（+compactThread 如 CLI 支持上下文压缩）
 *   [ ] 2. index.mjs import 并登记进 FACTORIES
 *   [ ] 3. manifest.mjs 加 ADAPTER_TEMPLATES 条目（跑 validateAdapterTemplate 自检）
 *   [ ] 4. manifest.mjs 加 ADAPTER_BINDINGS 条目（声明 teamMemberEligible/coordinatorCapable）
 *   [ ] 5. tests/adapters.test.mjs 补契约用例（createAdapters 后 binding 可实例化）
 *   [ ] 6. 本机 probe 实证 CLI 档位，回填 routingDefaults 与 controlNotes
 */

import { ADAPTER_TEMPLATES } from "./manifest.mjs";

/** template() 必填字段；缺失即模板不完整，createTeamCatalog 会把该席位渲染成不可用。 */
export const REQUIRED_TEMPLATE_FIELDS = ["id", "label", "factoryKey"];

/** adapter 实例必需方法（Orchestrator 派轮路径会真实调用）。 */
export const REQUIRED_ADAPTER_METHODS = ["send", "close"];

/** 可选方法及缺失时的行为（如实文档化，不做运行时探针）。 */
export const OPTIONAL_ADAPTER_METHODS = Object.freeze({
  compactThread: "缺失时 /compact 原生命令按 NATIVE_COMMAND_UNSUPPORTED fail-closed",
});

export function validateAdapterTemplate(template) {
  const errors = [];
  for (const field of REQUIRED_TEMPLATE_FIELDS) {
    if (!template?.[field]) errors.push(`template missing required field '${field}'`);
  }
  if (template?.permissionModes && !Array.isArray(template.permissionModes)) {
    errors.push("permissionModes must be an array");
  }
  if (template?.permissionModes?.length && template?.defaultPermissionMode
    && !template.permissionModes.includes(template.defaultPermissionMode)) {
    errors.push(`defaultPermissionMode '${template.defaultPermissionMode}' must be listed in permissionModes`);
  }
  if (template?.effortMode && template?.effortMode !== "argv" && !Array.isArray(template.effortLevels)) {
    errors.push("non-argv effortMode requires effortLevels array");
  }
  return { valid: errors.length === 0, id: template?.id ?? "?", errors };
}

export function validateAllTemplates(templates = ADAPTER_TEMPLATES) {
  return (Array.isArray(templates) ? templates : []).map(validateAdapterTemplate);
}
