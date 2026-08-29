const diagnostic = (definition) => Object.freeze({
  risk: "local-read",
  provenance: "native-cli-help",
  timeoutMs: 15_000,
  maxOutputBytes: 128 * 1024,
  ...definition,
  args: Object.freeze([...(definition.args || [])]),
});

const versionDiagnostic = () => diagnostic({
  id: "version",
  label: "读取 CLI 版本",
  detail: "运行当前席位可执行文件的只读版本探针。",
  args: ["--version"],
});

// 原生权限档的人类可读标签（席位编辑器选项用）；Codex 预设族给出官方语义说明
const NATIVE_PERMISSION_LABELS = Object.freeze({
  plan: "plan · 只读规划",
  "read-only": "read-only · 只读",
  "workspace-write": "workspace-write · 请求批准（on-request）",
  "workspace-write:on-failure": "workspace-write:on-failure · 帮我批准",
  "danger-full-access": "danger-full-access · 完全访问（never）",
  "config-default": "config-default · 自定义 config.toml",
  // CLI 原生透传档（2026-08-27 泛化，各 CLI --help/agent list 实证）
  "native:auto": "native:auto · CLI 原生安全检查放行",
  "native:acceptEdits": "native:acceptEdits · CLI 原生自动接受编辑",
  "native:always-approve": "native:always-approve · CLI 原生全自动",
  "native:bypassPermissions": "native:bypassPermissions · Claude 原生跳过权限提示",
  "native:autoEdit": "native:autoEdit · Gemini 原生自动批准编辑工具",
  "native:yolo": "native:yolo · CLI 原生 yolo 自动批准",
  "native:build": "native:build · OpenCode 原生 build agent 全权限",
});

const nativeCommand = (token, execution, extra = {}) => Object.freeze({
  token,
  execution,
  scope: extra.scope || "turn",
  risk: extra.risk || "read-only",
  detail: extra.detail || token,
  hook: extra.hook || null,
});

const template = (definition) => Object.freeze({
  ...definition,
  selectable: definition.selectable !== false,
  permissionModes: Object.freeze([...definition.permissionModes]),
  effortLevels: Object.freeze([...(definition.effortLevels || [])]),
  controlNotes: Object.freeze([...(definition.controlNotes || [])]),
  nativeCommands: Object.freeze((definition.nativeCommands || []).map((item) => Object.freeze({ ...item }))),
  diagnosticActions: Object.freeze([...(definition.diagnosticActions || [versionDiagnostic()])]),
  // 路由权重缺省：新建席位未显式填写时的校准起点（对齐同 CLI 内置席位实测档位）；未声明的通道保守落 0.5/0.5/3
  routingDefaults: Object.freeze({ quality: 0.5, speed: 0.5, costTier: 3, ...(definition.routingDefaults || {}) }),
});

export const ADAPTER_TEMPLATES = Object.freeze([
  template({
    id: "claude-stream-json", label: "Claude Code", factoryKey: "claude-cli",
    description: "Claude Code CLI 的 stream-json 执行通道，支持原生会话恢复。",
    transport: "local-cli", providerApp: "claude", providerBindingMode: "serialized-live-projection",
    requiresCommand: true, teamMemberEligible: true, coordinatorCapable: true,
    defaultCommand: "claude", defaultProvider: "anthropic",
    commandMode: "executable-only", promptMode: "stdin", modelMode: "argv", effortMode: "argv",
    // native:* 本机 claude 2.1.232 --help 实证（acceptEdits/bypassPermissions）；
    // manual/dontAsk/default 不透传：headless 下会交互挂起或与治理档语义重叠
    permissionModes: ["plan", "read-only", "workspace-write", "native:acceptEdits", "native:bypassPermissions"], defaultPermissionMode: "plan",
    effortLevels: ["low", "medium", "high", "xhigh", "max"], cwdMode: "per-turn",
    routingDefaults: { quality: 0.96, speed: 0.68, costTier: 4 },
    controlNotes: [
      "原生审批档仅作用于只读轮（LO 2026-08-27 实证）：native:acceptEdits 自动接受编辑；native:bypassPermissions 全自动（需审批）。Build 写盘轮固定 acceptEdits + 审批，不走原生档。",
    ],
    commandHelp: "本机 claude 可执行文件名或完整路径；不要在此附加参数。",
    nativeCommands: [
      nativeCommand("/compact", "passthrough", { detail: "压缩当前 Claude 会话上下文", risk: "write" }),
      nativeCommand("/cost", "passthrough", { detail: "读取本会话成本" }),
      nativeCommand("/usage", "passthrough", { detail: "读取本会话用量" }),
      nativeCommand("/context", "passthrough", { detail: "查看上下文窗口占用" }),
      nativeCommand("/memory", "passthrough", { detail: "打开 Claude 记忆" }),
      nativeCommand("/rewind", "passthrough", { detail: "回退最近一轮", risk: "write" }),
    ],
    diagnosticActions: [
      versionDiagnostic(),
      diagnostic({ id: "doctor", label: "运行 Claude Doctor", detail: "只读检查当前目录可见的 Claude Code 设置与安装健康。", args: ["doctor"], risk: "process-probe" }),
      diagnostic({ id: "auth-status", label: "读取 Claude 登录态", detail: "以 JSON 读取 Claude Code 当前认证状态；输出统一脱敏。", args: ["auth", "status", "--json"] }),
      diagnostic({ id: "agent-list", label: "列出 Claude Agents", detail: "以 JSON 读取 Claude Code 当前可用 Agent 目录。", args: ["agents", "--json"] }),
      diagnostic({ id: "mcp-list", label: "列出 Claude MCP", detail: "读取 Claude Code 当前可见的 MCP 服务器与连接状态。", args: ["mcp", "list"], timeoutMs: 45_000, risk: "network-probe" }),
      diagnostic({ id: "plugin-list", label: "列出 Claude 插件", detail: "读取 Claude Code 已安装插件目录，不执行安装或更新。", args: ["plugin", "list"] }),
    ],
  }),
  template({
    id: "codex-app-server", label: "Codex", factoryKey: "codex-app-server",
    description: "Codex app-server 执行通道，保留审批与生命周期事件。",
    transport: "local-rpc", providerApp: "codex", providerBindingMode: "serialized-live-projection",
    requiresCommand: true, teamMemberEligible: true, coordinatorCapable: true,
    defaultCommand: "codex", defaultProvider: "openai",
    fallbackAdapterId: "codex-exec-json", fallbackFactoryKey: "codex-cli",
    commandMode: "executable-only", promptMode: "rpc", modelMode: "thread-start", effortMode: "turn-start",
    permissionModes: ["plan", "read-only", "workspace-write", "workspace-write:on-failure", "danger-full-access", "config-default"], defaultPermissionMode: "read-only",
    effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], cwdMode: "process-fixed",
    routingDefaults: { quality: 0.97, speed: 0.74, costTier: 4 },
    commandHelp: "本机 codex 可执行文件名或完整路径；Adapter 会自行追加 app-server 参数。",
    nativeCommands: [
      nativeCommand("/compact", "adapter-hook", {
        hook: "compactThread",
        detail: "调用 Codex app-server 压缩当前线程，不把 /compact 当普通 prompt",
        risk: "write",
      }),
    ],
    diagnosticActions: [
      versionDiagnostic(),
      diagnostic({ id: "doctor", label: "运行 Codex Doctor", detail: "读取已脱敏的安装、配置、认证与运行健康摘要。", args: ["doctor", "--json"], timeoutMs: 45_000, risk: "process-probe" }),
      diagnostic({ id: "login-status", label: "读取 Codex 登录态", detail: "读取 Codex CLI 当前登录状态，不执行登录或登出。", args: ["login", "status"] }),
      diagnostic({ id: "features", label: "列出 Codex Features", detail: "读取当前 Codex feature flags，不修改 config.toml。", args: ["features", "list"] }),
      diagnostic({ id: "mcp-list", label: "列出 Codex MCP", detail: "读取 Codex 当前注册的 MCP 服务器，不修改配置。", args: ["mcp", "list"], risk: "network-probe" }),
      diagnostic({ id: "plugin-list", label: "列出 Codex 插件", detail: "读取 Codex 已安装插件，不执行安装或更新。", args: ["plugin", "list"] }),
    ],
  }),
  template({
    id: "codex-exec-json", label: "Codex（exec 回退）", factoryKey: "codex-cli",
    description: "Codex app-server 发生可安全重放的传输故障时使用的受限回退通道。",
    transport: "local-cli", providerApp: "codex", providerBindingMode: "serialized-live-projection",
    requiresCommand: true, teamMemberEligible: false, coordinatorCapable: false, selectable: false,
    defaultCommand: "codex", defaultProvider: "openai",
    commandMode: "executable-only", promptMode: "stdin", modelMode: "argv", effortMode: "argv",
    permissionModes: ["read-only"], defaultPermissionMode: "read-only",
    effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], cwdMode: "per-turn",
    commandHelp: "由 Codex app-server 自动托管的只读回退，不可单独创建席位。",
    nativeCommands: [
      nativeCommand("/compact", "cli-attach", { detail: "exec 回退通道没有 app-server compact；请用 /cli 附着 Codex TUI。" }),
    ],
  }),
  template({
    id: "gemini-stream-json", label: "Gemini CLI", factoryKey: "gemini-cli",
    description: "Gemini CLI 的 stream-json 执行通道。",
    transport: "local-cli", providerApp: "gemini", providerBindingMode: "serialized-live-projection",
    requiresCommand: true, teamMemberEligible: true, coordinatorCapable: true,
    defaultCommand: "gemini", defaultProvider: "google",
    commandMode: "executable-only", promptMode: "stdin", modelMode: "argv", effortMode: "none",
    // native:* 本机 gemini 0.54.4 --help 实证（--approval-mode auto_edit/yolo）；
    // default=逐项询问 headless 挂起，不透传
    permissionModes: ["plan", "read-only", "native:autoEdit", "native:yolo"], defaultPermissionMode: "plan",
    effortLevels: [], cwdMode: "process-fixed",
    routingDefaults: { quality: 0.88, speed: 0.72, costTier: 3 },
    commandHelp: "本机 gemini 可执行文件名或完整路径；当前 Adapter 固定使用 plan 审批模式。",
    controlNotes: [
      "Gemini CLI 当前没有接入通用 effort 参数。",
      "原生审批档仅作用于只读轮（LO 2026-08-27 实证）：native:autoEdit 自动批准编辑工具；native:yolo 自动批准全部工具（需审批）。Gemini 无独立写盘治理轮。",
    ],
    nativeCommands: [
      nativeCommand("/tui", "cli-attach", { detail: "Gemini 原生命令请用 /cli 附着交互 TUI。" }),
    ],
    diagnosticActions: [
      versionDiagnostic(),
      diagnostic({ id: "mcp-list", label: "列出 Gemini MCP", detail: "读取 Gemini CLI 当前配置的 MCP 服务器。", args: ["mcp", "list"], risk: "network-probe" }),
      diagnostic({ id: "extension-list", label: "列出 Gemini 扩展", detail: "读取已安装扩展，不执行安装或更新。", args: ["extensions", "list"] }),
      diagnostic({ id: "skill-list", label: "列出 Gemini Skills", detail: "读取所有已发现的 Gemini Skills。", args: ["skills", "list", "--all"] }),
    ],
  }),
  template({
    id: "grok-mcp-via-codex-app-server", label: "Grok Search MCP", factoryKey: "grok-mcp",
    description: "通过隔离的 Codex app-server 主机调用 grok-search-rs MCP。",
    transport: "mcp", providerApp: null, providerBindingMode: "environment-managed",
    requiresCommand: false, teamMemberEligible: true, coordinatorCapable: false, selectable: false,
    defaultCommand: null, defaultProvider: "xai-compatible",
    commandMode: "none", promptMode: "rpc", modelMode: "none", effortMode: "none",
    permissionModes: ["read-only"], defaultPermissionMode: "read-only",
    effortLevels: [], cwdMode: "process-fixed",
    commandHelp: "由隔离的 Codex MCP 主机管理，不接受席位级执行命令。",
    controlNotes: ["MCP 工具通道而非 CLI 执行后端——仅供内置 grok-search 席位固定绑定，新建席位不可选。"],
    nativeCommands: [],
  }),
  template({
    id: "grok-build-headless", label: "Grok Build", factoryKey: "grok-build",
    description: "Grok Build headless streaming-json 执行通道。",
    transport: "local-cli", providerApp: "grokbuild", providerBindingMode: "serialized-live-projection",
    requiresCommand: true, teamMemberEligible: true, coordinatorCapable: true,
    defaultCommand: "grok", defaultProvider: "xai",
    commandMode: "executable-only", promptMode: "argv", modelMode: "argv", effortMode: "argv",
    permissionModes: ["plan", "read-only", "workspace-write", "native:auto", "native:acceptEdits", "native:always-approve"], defaultPermissionMode: "read-only",
    effortLevels: ["low", "medium", "high", "xhigh"], cwdMode: "per-turn",
    routingDefaults: { quality: 0.82, speed: 0.94, costTier: 3 },
    commandHelp: "本机 grok 可执行文件名或完整路径；Adapter 会追加 headless 参数。",
    controlNotes: [
      "档位对齐 grok /effort 菜单（xhigh=Extra High）；模型仅接受其菜单公布的档位。",
      "2026-08-27 本机实证（grok 1.0.5，headless -p + streaming-json，60s 内）：native:auto（--permission-mode auto）、native:acceptEdits（--permission-mode acceptEdits）、native:always-approve（--always-approve）三档均正常收尾 {\"type\":\"end\"}、exit 0、无权限提示挂起，全部进入透传白名单。",
      "原生审批档只对只读语义轮（非写盘轮）透传；写盘轮安全不变量不受影响，仍固定 --permission-mode dontAsk + GROK_BUILD_TOOLS 白名单 + --deny MCPTool。",
    ],
    nativeCommands: [
      nativeCommand("/tui", "cli-attach", { detail: "Grok Build headless 不执行交互 slash；完整 TUI 请用 /cli 附着。" }),
    ],
    diagnosticActions: [
      versionDiagnostic(),
      diagnostic({ id: "doctor", label: "运行 Grok Doctor", detail: "检查终端、剪贴板、颜色和输入支持，结果不会写配置。", args: ["doctor", "--json"], risk: "process-probe" }),
      diagnostic({ id: "inspect", label: "检查 Grok 配置", detail: "以 JSON 读取当前目录生效的 Grok 配置；输出统一脱敏。", args: ["inspect", "--json"] }),
      diagnostic({ id: "models", label: "列出 Grok 模型", detail: "读取当前 Grok Build 可用模型目录。", args: ["models"], risk: "network-probe" }),
      diagnostic({ id: "mcp-list", label: "列出 Grok MCP", detail: "读取 Grok Build 当前 MCP 目录与状态。", args: ["mcp", "list"], risk: "network-probe" }),
      diagnostic({ id: "plugin-list", label: "列出 Grok 插件", detail: "读取 Grok Build 当前插件目录。", args: ["plugin", "list"] }),
      diagnostic({ id: "session-list", label: "列出 Grok 会话", detail: "读取 Grok Build 本地会话目录。", args: ["sessions", "list"] }),
    ],
  }),
  template({
    id: "kimi-headless-resume", label: "Kimi Code", factoryKey: "kimi-cli",
    description: "Kimi Code prompt 模式执行通道。",
    transport: "local-cli", providerApp: "kimi", providerBindingMode: "serialized-live-projection",
    requiresCommand: true, teamMemberEligible: true, coordinatorCapable: true,
    defaultCommand: "kimi", defaultProvider: "moonshot",
    commandMode: "executable-only", promptMode: "argv", modelMode: "argv", effortMode: "env",
    // native:* 本机 kimi 0.36.0 --help 实证（--yolo / --auto）；写盘轮本就 fail-closed
    permissionModes: ["plan", "read-only", "native:yolo", "native:auto"], defaultPermissionMode: "read-only",
    effortLevels: ["low", "high", "max"], cwdMode: "per-turn",
    routingDefaults: { quality: 0.82, speed: 0.88, costTier: 2 },
    commandHelp: "本机 kimi 可执行文件名或完整路径；不要在此附加参数。未绑定统一供应商时，登录和 token 由 Kimi CLI 自身管理。",
    controlNotes: [
      "Kimi CLI 支持模型选择；effort 经 KIMI_MODEL_THINKING_EFFORT 逐轮 env 注入（仅 kimi provider，绕过 support_efforts）。",
      "档位对齐 managed k3/k3-256k 实测 low/high/max；kimi-for-coding 等未声明档位的模型可能被服务端拒绝或回退默认档。写权限保持 fail-closed。",
      "绑定统一供应商后投影 ~/.kimi-code/config.toml（default_model + providers/models 标记块）；effort env 仅对 type=kimi 的供应商生效。",
      "原生审批档仅作用于只读轮（LO 2026-08-27 实证）：native:yolo 自动批准常规工具调用；native:auto 完全自治（需审批）。写盘轮 fail-closed 不变。",
    ],
    nativeCommands: [
      nativeCommand("/tui", "cli-attach", { detail: "Kimi 写盘 fail-closed；交互 slash 请用 /cli 附着原生 TUI。" }),
    ],
    diagnosticActions: [
      versionDiagnostic(),
      diagnostic({ id: "doctor", label: "校验 Kimi 配置", detail: "调用 Kimi Doctor 校验 config.toml，不打印凭据。", args: ["doctor", "config"] }),
      diagnostic({ id: "doctor-tui", label: "校验 Kimi TUI", detail: "调用 Kimi Doctor 校验 tui.toml。", args: ["doctor", "tui"] }),
      diagnostic({ id: "provider-list", label: "列出 Kimi Providers", detail: "读取 Kimi CLI 已配置 Provider 与模型数量；输出统一脱敏。", args: ["provider", "list"] }),
    ],
  }),
  template({
    id: "opencode-run-json", label: "OpenCode", factoryKey: "opencode-cli",
    description: "OpenCode run --format json 执行通道，支持 -s 原生会话恢复。",
    transport: "local-cli", providerApp: "opencode", providerBindingMode: "serialized-live-projection",
    requiresCommand: true, teamMemberEligible: true, coordinatorCapable: true,
    defaultCommand: "opencode", defaultProvider: "multi-provider",
    commandMode: "executable-only", promptMode: "argv", modelMode: "argv", effortMode: "argv",
    // native:* 本机 opencode 1.18.23 agent list 实证：内置 primary 仅 build（全权）与
    // plan（只读），无中间审批档；写盘轮维持 --auto 治理路径
    permissionModes: ["plan", "read-only", "workspace-write", "native:build"], defaultPermissionMode: "read-only",
    effortLevels: [], cwdMode: "per-turn",
    routingDefaults: { quality: 0.8, speed: 0.85, costTier: 2 },
    commandHelp: "本机 opencode 可执行文件名或完整路径；不要在此附加参数。模型与密钥由供应商投影到 opencode.json。",
    controlNotes: [
      "effort 透传 opencode --variant；仅当运行席位或 Provider 明确声明 variant 目录时才展示，不生成通用档位。",
      "权限映射：plan → --agent plan；read-only → headless 默认拒绝写；workspace-write → --auto。",
      "native:build 透传 --agent build（LO 2026-08-27 实证，全权限 primary agent）；仅作用于只读治理轮。",
      "质量/速度实测随绑定供应商浮动——当前缺省为开源 harness 中性档，绑定强模型后建议手动上调质量。",
    ],
    nativeCommands: [
      nativeCommand("/tui", "cli-attach", { detail: "OpenCode 交互 slash 请用 /cli 附着原生 TUI。" }),
    ],
    diagnosticActions: [
      versionDiagnostic(),
      diagnostic({ id: "usage", label: "读取 OpenCode 用量", detail: "调用 opencode stats 读取本地 token 与成本统计。", args: ["stats"] }),
      diagnostic({ id: "mcp-list", label: "列出 OpenCode MCP", detail: "读取 OpenCode MCP 服务器与状态。", args: ["mcp", "list"], risk: "network-probe" }),
      diagnostic({ id: "agent-list", label: "列出 OpenCode Agents", detail: "读取 OpenCode 当前可用 Agent 目录。", args: ["agent", "list"] }),
      diagnostic({ id: "models", label: "列出 OpenCode 模型", detail: "读取 OpenCode 当前模型目录。", args: ["models"], risk: "network-probe" }),
      diagnostic({ id: "session-list", label: "列出 OpenCode 会话", detail: "读取 OpenCode 本地会话目录。", args: ["session", "list"] }),
    ],
  }),
  template({
    id: "pi-rpc", label: "Pi", factoryKey: "pi-rpc",
    description: "Pi 常驻 JSONL RPC 会话。",
    transport: "local-rpc", providerApp: null, providerBindingMode: "adapter-managed",
    requiresCommand: true, teamMemberEligible: true, coordinatorCapable: true,
    defaultCommand: "pi", defaultProvider: "multi-provider",
    commandMode: "executable-only", promptMode: "rpc", modelMode: "session-start", effortMode: "session-start",
    permissionModes: ["read-only"], defaultPermissionMode: "read-only",
    effortLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], cwdMode: "process-fixed",
    routingDefaults: { quality: 0.8, speed: 0.86, costTier: 2 },
    commandHelp: "本机 pi 可执行文件名或完整路径；Provider 由 Pi 内部路由。",
    controlNotes: ["Pi thinking 在 RPC 会话启动时接入；续聊沿用创建会话时固化的档位。"],
    nativeCommands: [
      nativeCommand("/tui", "cli-attach", { detail: "Pi RPC 不执行交互 slash；完整 TUI 请用 /cli 附着。" }),
    ],
    diagnosticActions: [
      versionDiagnostic(),
      diagnostic({ id: "extensions", label: "列出 Pi 扩展", detail: "读取 Pi settings 中已安装的扩展资源，不修改配置。", args: ["list"] }),
      diagnostic({ id: "models", label: "列出 Pi 模型", detail: "离线读取 Pi 当前可用模型目录，不注入 Provider 凭据。", args: ["--offline", "--list-models"], timeoutMs: 45_000 }),
    ],
  }),
]);

export const ADAPTER_BINDINGS = Object.freeze([
  { profileId: "claude-fable", adapterId: "claude-stream-json", factoryKey: "claude-cli", requiresCommand: true, teamMemberEligible: true, coordinatorEligible: true },
  { profileId: "codex-technical", adapterId: "codex-app-server", factoryKey: "codex-app-server", requiresCommand: true, teamMemberEligible: true, coordinatorEligible: true },
  { profileId: "codex-technical-fallback", adapterId: "codex-exec-json", factoryKey: "codex-cli", fallbackFor: "codex-technical", requiresCommand: false, teamMemberEligible: false, coordinatorEligible: false },
  { profileId: "gemini-research", adapterId: "gemini-stream-json", factoryKey: "gemini-cli", requiresCommand: true, teamMemberEligible: true, coordinatorEligible: true },
  { profileId: "grok-search", adapterId: "grok-mcp-via-codex-app-server", factoryKey: "grok-mcp", requiresCommand: false, teamMemberEligible: true, coordinatorEligible: false },
  { profileId: "grok-build", adapterId: "grok-build-headless", factoryKey: "grok-build", requiresCommand: true, teamMemberEligible: true, coordinatorEligible: true },
  { profileId: "kimi-frontend", adapterId: "kimi-headless-resume", factoryKey: "kimi-cli", requiresCommand: true, teamMemberEligible: true, coordinatorEligible: true },
  { profileId: "pi-resident", adapterId: "pi-rpc", factoryKey: "pi-rpc", requiresCommand: true, teamMemberEligible: true, coordinatorEligible: true },
].map(Object.freeze));

const TEMPLATE_BY_ID = new Map(ADAPTER_TEMPLATES.map((item) => [item.id, item]));
const BINDING_BY_PROFILE = new Map(ADAPTER_BINDINGS.filter((item) => !item.fallbackFor).map((item) => [item.profileId, item]));
const BINDING_BY_PROFILE_ALL = new Map(ADAPTER_BINDINGS.map((item) => [item.profileId, item]));

export function adapterTemplateForRuntimeProfileId(profileId) {
  const binding = BINDING_BY_PROFILE_ALL.get(String(profileId || "").trim());
  if (!binding) return null;
  return TEMPLATE_BY_ID.get(binding.adapterId) || null;
}

function manifestError(message, details = {}) {
  return Object.assign(new Error(message), { code: "ADAPTER_MANIFEST_INVALID", ...details });
}

export function adapterTemplateCatalog() {
  // 全量返回（含 selectable 标记）：编辑器渲染绑定非可选 Adapter 的内置席位时仍需模板详情；
  // 新建席位下拉由 UI 按 selectable 过滤，服务端写路径另有 selectable 校验（server.mjs runtimeSeatTemplate）。
  return ADAPTER_TEMPLATES.map((item) => {
    const { factoryKey: _factoryKey, fallbackFactoryKey: _fallbackFactoryKey, ...view } = item;
    return {
      ...view,
      permissionModes: [...item.permissionModes],
      effortLevels: [...item.effortLevels],
      nativeCommands: item.nativeCommands.map((command) => ({ ...command })),
      controlNotes: [...item.controlNotes],
      diagnosticActions: item.diagnosticActions.map(({ args: _args, timeoutMs: _timeoutMs, maxOutputBytes: _maxOutputBytes, ...action }) => ({ ...action })),
      routingDefaults: { ...item.routingDefaults },
    };
  });
}

export function resolveAdapterTemplate(profile = {}) {
  const profileId = String(profile.id ?? "").trim();
  const adapterId = String(profile.adapter ?? "").trim();
  const fixedBinding = BINDING_BY_PROFILE.get(profileId) || null;
  if (fixedBinding && adapterId !== fixedBinding.adapterId) {
    throw manifestError(`${profileId} config declares ${adapterId || "no adapter"}, expected ${fixedBinding.adapterId}`);
  }
  if (!fixedBinding && profile.builtin !== false) {
    throw manifestError(`runtime profile ${profileId || "<missing>"} has no executable adapter binding; custom seats must declare builtin=false`);
  }
  const adapterTemplate = TEMPLATE_BY_ID.get(adapterId);
  if (!adapterTemplate || (!fixedBinding && !adapterTemplate.selectable)) {
    throw manifestError(`runtime profile ${profileId || "<missing>"} references unsupported adapter template ${adapterId || "<missing>"}`);
  }
  return { adapterTemplate, fixedBinding };
}

const modelOption = (entry) => ({
  id: String(entry?.id ?? "").trim(),
  label: String(entry?.label || entry?.id || "").trim(),
});

/**
 * Runtime/editor/composer control contract. This is the only place that turns
 * adapter mechanics into UI controls and normalized slash commands.
 */
export function runtimeControlCatalog(profile = {}, discovered = {}) {
  const { adapterTemplate } = resolveAdapterTemplate(profile);
  const modelSupported = adapterTemplate.modelMode !== "none";
  const discoveredEffortLevels = (discovered.effortLevels || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  const declaredEffortLevels = [...new Set([
    ...discoveredEffortLevels,
    ...(profile.effortLevels || []),
    ...adapterTemplate.effortLevels,
  ].map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  const effortSupported = adapterTemplate.effortMode !== "none" && declaredEffortLevels.length > 0;
  const models = modelSupported
    ? (discovered.models || profile.modelOptions || []).map(modelOption).filter((entry) => entry.id)
    : [];
  const effortLevels = effortSupported ? declaredEffortLevels : [];
  const modelSource = String(discovered.modelSource || discovered.source || "fallback");
  const effortSource = String(discovered.effortSource || (
    discoveredEffortLevels.length
      ? discovered.source || "dynamic"
      : profile.effortLevels?.length
        ? "runtime-profile"
        : adapterTemplate.effortLevels.length
          ? "adapter-manifest"
          : "unsupported"
  ));
  const source = modelSource;
  const commands = [];

  if (modelSupported) {
    commands.push({
      id: "model:default", token: "/model", label: "/model default",
      detail: `跟随 ${profile.label || profile.id || adapterTemplate.label} 的默认模型`,
      control: "model", value: "", scope: "create-run", provenance: modelSource,
      execution: "composer-control", risk: "read-only",
    });
    for (const entry of models) {
      commands.push({
        id: `model:${entry.id}`, token: "/model", label: `/model ${entry.id}`,
        detail: `${entry.label} · ${adapterTemplate.label}`,
        control: "model", value: entry.id, scope: "create-run", provenance: modelSource,
        execution: "composer-control", risk: "read-only",
      });
    }
  }
  if (effortSupported) {
    for (const level of effortLevels) {
      commands.push({
        id: `effort:${level}`, token: "/effort", label: `/effort ${level}`,
        detail: `${adapterTemplate.label} 推理强度`,
        control: "effort", value: level, scope: "create-run", provenance: effortSource,
        execution: "composer-control", risk: "read-only",
      });
    }
  }
  // Codex 官方权限档（LO 2026-08-09）：与 Codex 桌面批准菜单同款四档，adapter 声明
  // danger-full-access（预设族标记位）即用官方档替换 514cc 自造的 plan/review/build 命令组。
  const permissionCommands = adapterTemplate.permissionModes.includes("danger-full-access")
    ? [
      ["workspace-write", "ask", "请求批准 · 编辑外部文件和使用互联网时始终询问"],
      ["workspace-write:on-failure", "auto", "帮我批准 · 仅对检测到的风险操作请求批准"],
      ["danger-full-access", "full-access", "完全访问权限 · 不限制互联网与文件"],
      ["config-default", "config", "自定义 · 使用 config.toml 中定义的权限"],
    ]
    : [
      ["plan", "plan", "Plan 只读规划"],
      ["read-only", "review", "Review 只读深审"],
      ["workspace-write", "build", "Build 写盘（仍需审批）"],
    ];
  for (const [nativeMode, value, detail] of permissionCommands) {
    if (!adapterTemplate.permissionModes.includes(nativeMode)) continue;
    commands.push({
      id: `permission:${value}`, token: `/${value}`, label: `/${value}`, detail,
      control: "permission", value, scope: "create-run", provenance: "514cc-policy",
      execution: "composer-control", risk: value === "build" ? "approval-required" : value === "plan" || value === "review" ? "read-only" : "write",
    });
  }
  // CLI 原生权限档（native: 前缀）：仅在 Adapter 模板显式声明时追加独立命令组，
  // 与 514cc-policy 三档组并列，供 composer 直接透传 CLI 原生值。描述按 adapter 分派。
  const nativePermissionCatalog = {
    "grok-build-headless": [
      ["native:auto", "native:auto", "Grok 原生 auto · 安全检查放行，其余拦截或升级", "write"],
      ["native:acceptEdits", "native:acceptEdits", "Grok 原生 acceptEdits · 自动接受文件编辑", "approval-required"],
      ["native:always-approve", "native:always-approve", "Grok 原生 always-approve · 全自动（需审批）", "approval-required"],
    ],
    "claude-stream-json": [
      ["native:acceptEdits", "native:acceptEdits", "Claude 原生 acceptEdits · 自动接受文件编辑", "write"],
      ["native:bypassPermissions", "native:bypassPermissions", "Claude 原生 bypassPermissions · 跳过全部权限提示（需审批）", "approval-required"],
    ],
    "gemini-stream-json": [
      ["native:autoEdit", "native:autoEdit", "Gemini 原生 auto_edit · 自动批准编辑工具", "write"],
      ["native:yolo", "native:yolo", "Gemini 原生 yolo · 自动批准全部工具（需审批）", "approval-required"],
    ],
    "kimi-headless-resume": [
      ["native:yolo", "native:yolo", "Kimi 原生 yolo · 自动批准常规工具调用", "write"],
      ["native:auto", "native:auto", "Kimi 原生 auto · 完全自治不提问（需审批）", "approval-required"],
    ],
    "opencode-run-json": [
      ["native:build", "native:build", "OpenCode 原生 build agent · 全权限执行", "write"],
    ],
  };
  const nativePermissionCommands = nativePermissionCatalog[adapterTemplate.id] ?? [];
  for (const [nativeMode, value, detail, risk] of nativePermissionCommands) {
    if (!adapterTemplate.permissionModes.includes(nativeMode)) continue;
    commands.push({
      id: `permission:${value}`, token: `/${value}`, label: `/${value}`, detail,
      control: "permission", value, scope: "create-run", provenance: "cli-native",
      execution: "composer-control", risk,
    });
  }

  for (const item of adapterTemplate.nativeCommands) {
    commands.push({
      id: `native:${item.token}`,
      token: item.token,
      label: item.token,
      detail: item.detail,
      control: "native",
      value: item.token,
      scope: item.scope || "turn",
      provenance: "adapter-native",
      execution: item.execution,
      hook: item.hook || null,
      risk: item.risk || "read-only",
    });
  }

  const actions = [
    {
      id: "refresh-catalog", label: "刷新能力目录", detail: "清除 5 分钟缓存并重新读取当前 CLI 的模型与推理档位。",
      group: "diagnostics", scope: "runtime-profile", provenance: "514cc-control-plane",
      execution: "server-catalog-refresh", risk: "read-only",
    },
    ...adapterTemplate.diagnosticActions.map(({ args: _args, timeoutMs: _timeoutMs, maxOutputBytes: _maxOutputBytes, ...action }) => ({
      ...action,
      group: "diagnostics",
      scope: "runtime-profile",
      execution: "allowlisted-cli",
    })),
    {
      id: "open-seat-config", label: "编辑席位完整配置", detail: "打开该运行席位的命令、模型、权限、提示词和路由权重。",
      group: "configuration", scope: "runtime-profile", provenance: "514cc-control-plane",
      execution: "frontend-seat-editor", risk: "configuration-write",
    },
    {
      id: "open-capabilities", label: "管理 Skill 与 MCP", detail: "打开配置图谱并聚焦当前逻辑成员的 Skill、Agent 与 MCP 能力。",
      group: "configuration", scope: "logical-member", provenance: "514cc-control-plane",
      execution: "frontend-capability-editor", risk: "configuration-write",
    },
  ];
  if (adapterTemplate.providerApp || adapterTemplate.providerBindingMode !== "serialized-live-projection") {
    actions.push({
      id: "open-connection", label: adapterTemplate.providerApp ? "编辑 Provider 连接" : "查看 CLI 认证归属",
      detail: adapterTemplate.providerApp
        ? "打开与当前 CLI 应用匹配的 Provider 配置；密钥不会进入浏览器响应。"
        : "当前 Adapter 的认证由 CLI 或 Adapter 自身管理。",
      group: "configuration", scope: "runtime-profile", provenance: "514cc-control-plane",
      execution: "frontend-connection-editor", risk: adapterTemplate.providerApp ? "credential-configuration" : "read-only",
    });
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    context: {
      runtimeProfileId: String(profile.id || ""),
      runtimeProfileLabel: String(profile.label || profile.id || adapterTemplate.label),
      adapterId: adapterTemplate.id,
      adapterLabel: adapterTemplate.label,
      transport: adapterTemplate.transport,
      providerApp: adapterTemplate.providerApp,
      providerId: profile.providerId == null ? null : String(profile.providerId),
      providerBindingMode: adapterTemplate.providerBindingMode,
      selectable: adapterTemplate.selectable,
      enabled: profile.enabled !== false,
    },
    models,
    effortLevels,
    defaultModel: discovered.defaultModel ?? profile.model ?? null,
    source,
    sources: { model: modelSource, effort: effortSource },
    coverage: {
      commands: "composer-native-controls",
      diagnostics: "allowlisted-read-only-subset",
      configuration: "transactional-deep-links",
    },
    controls: {
      command: {
        supported: adapterTemplate.commandMode !== "none",
        mode: adapterTemplate.commandMode,
        value: profile.command ?? adapterTemplate.defaultCommand ?? null,
        defaultValue: adapterTemplate.defaultCommand,
        help: adapterTemplate.commandHelp,
      },
      model: {
        supported: modelSupported,
        mode: adapterTemplate.modelMode,
        options: models.map((entry) => ({ value: entry.id, label: entry.label })),
        defaultValue: discovered.defaultModel ?? profile.model ?? null,
        source: modelSource,
      },
      effort: {
        supported: effortSupported,
        mode: adapterTemplate.effortMode,
        options: effortLevels.map((value) => ({ value, label: value })),
        // 镜像 defaultModel 的回退模式：席位级配置优先，发现值（~/.grok/config.toml
        // [models].default_reasoning_effort）兜底，两者都缺才是 null。
        defaultValue: profile.defaultEffort ?? discovered.defaultEffort ?? null,
        source: effortSource,
      },
      permission: {
        supported: true,
        options: adapterTemplate.permissionModes.map((value) => ({ value, label: NATIVE_PERMISSION_LABELS[value] || value })),
        defaultValue: profile.defaultPermissionMode || adapterTemplate.defaultPermissionMode,
      },
      cwd: { mode: adapterTemplate.cwdMode },
    },
    defaults: {
      model: profile.model ?? null,
      effort: profile.defaultEffort ?? discovered.defaultEffort ?? null,
      permission: profile.defaultPermissionMode || adapterTemplate.defaultPermissionMode,
      quickEditable: adapterTemplate.selectable,
      patchFields: adapterTemplate.selectable ? ["model", "defaultEffort", "defaultPermissionMode"] : [],
    },
    connection: {
      mode: adapterTemplate.providerBindingMode,
      providerApp: adapterTemplate.providerApp,
      providerId: profile.providerId == null ? null : String(profile.providerId),
      managedBy: adapterTemplate.providerBindingMode === "serialized-live-projection" ? "provider-store" : adapterTemplate.providerBindingMode,
    },
    commands,
    actions,
    notes: [...adapterTemplate.controlNotes],
  };
}

export function runtimeDiagnosticAction(profile = {}, actionId = "") {
  const { adapterTemplate } = resolveAdapterTemplate(profile);
  const action = adapterTemplate.diagnosticActions.find((entry) => entry.id === actionId);
  if (!action) {
    throw Object.assign(new Error(`unsupported CLI diagnostic action for ${adapterTemplate.id}: ${actionId || "missing"}`), {
      code: "AGENT_ACTION_UNSUPPORTED",
      runtimeProfileId: String(profile.id || ""),
      actionId,
    });
  }
  if (adapterTemplate.commandMode === "none" || !String(profile.command || adapterTemplate.defaultCommand || "").trim()) {
    throw Object.assign(new Error(`${adapterTemplate.label} has no executable command for diagnostics`), {
      code: "ADAPTER_UNAVAILABLE",
      runtimeProfileId: String(profile.id || ""),
      actionId,
    });
  }
  return {
    ...action,
    args: [...action.args],
    command: String(profile.command || adapterTemplate.defaultCommand),
    adapterId: adapterTemplate.id,
  };
}

// Provider 绑定是运行时数据（连接/密钥按设计不进仓）——仓内席位引用当前环境解析不到的
// provider 时降级为 Adapter 管理并显式告警，不再拖垮整个控制面启动（2026-08-03 LO 裁决）。
// 结构性矛盾（Adapter 模板根本不支持 provider 绑定）仍是硬错误。
export function resolveProviderBinding(profile, adapterTemplate, providerStore) {
  const providerId = profile.providerId == null ? null : String(profile.providerId).trim() || null;
  if (!providerId) return { providerId: null, provider: null, degraded: null };
  if (!adapterTemplate.providerApp) {
    throw manifestError(`${profile.id} adapter ${adapterTemplate.id} cannot bind a ProviderStore connection`, { runtimeProfileId: profile.id, providerId });
  }
  if (!providerStore?.get) {
    return { providerId: null, provider: null, degraded: { providerId, reason: "provider-store-unavailable" } };
  }
  let provider;
  try { provider = providerStore.get(providerId); }
  catch (error) {
    return { providerId: null, provider: null, degraded: { providerId, reason: "provider-missing", detail: error?.code || error?.message || null } };
  }
  if (provider.apps?.[adapterTemplate.providerApp] !== true) {
    return { providerId: null, provider: null, degraded: { providerId, reason: "provider-app-disabled", providerApp: adapterTemplate.providerApp } };
  }
  return { providerId, provider, degraded: null };
}

export function createTeamCatalog(profiles = [], { providerStore = null, onProviderDegraded = null } = {}) {
  return Object.freeze(profiles.map((profile) => {
    const id = String(profile?.id ?? "").trim();
    if (!id) throw manifestError("runtime profile id is required");
    const { adapterTemplate, fixedBinding } = resolveAdapterTemplate(profile);
    const { providerId, provider, degraded } = resolveProviderBinding(profile, adapterTemplate, providerStore);
    if (degraded) onProviderDegraded?.({ runtimeProfileId: id, adapterId: adapterTemplate.id, ...degraded });
    const commandConfigured = !adapterTemplate.requiresCommand || Boolean(String(profile.command ?? "").trim());
    const enabled = profile.enabled !== false;
    const teamMemberEligible = adapterTemplate.teamMemberEligible && commandConfigured && enabled;
    const coordinatorAllowed = profile.coordinatorEligible !== false;
    return Object.freeze({
      id, label: String(profile.label || id), role: String(profile.role || ""),
      provider: provider?.name || String(profile.provider || adapterTemplate.defaultProvider || ""),
      providerId, providerType: provider?.providerType || String(profile.provider || adapterTemplate.defaultProvider || ""),
      providerApp: adapterTemplate.providerApp, providerBindingMode: adapterTemplate.providerBindingMode,
      providerDegraded: degraded ? Object.freeze({ ...degraded }) : null,
      adapter: adapterTemplate.id, adapterLabel: adapterTemplate.label, templateId: adapterTemplate.id,
      transport: adapterTemplate.transport, capabilities: Object.freeze(["*"]), builtin: Boolean(fixedBinding), enabled, teamMemberEligible,
      coordinatorCapable: adapterTemplate.coordinatorCapable, coordinatorAllowed,
      coordinatorEligible: teamMemberEligible && adapterTemplate.coordinatorCapable && coordinatorAllowed,
      eligibilityReason: teamMemberEligible ? null : !enabled ? "profile-disabled" : !commandConfigured ? "command-not-configured" : "adapter-not-team-eligible",
    });
  }));
}
