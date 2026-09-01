/**
 * state.js — 514cc Console 全局状态管理
 *
 * 从 app.js 抽取的全局状态。
 * v4.0 app.js 组件化第三步：状态管理独立模块。
 */

// 活跃运行状态
export const ACTIVE_RUN_STATES = new Set([
  "queued", "waiting_agent", "waiting_approval", "planning",
  "waiting_for_approval", "executing", "integrating", "verifying",
  "active", "running", "recovery_required",
]);

// 终态运行状态
export const TERMINAL_RUN_STATES = new Set([
  "complete", "completed", "succeeded", "failed", "blocked", "cancelled", "canceled",
]);

export const MAX_REQUESTED_AGENTS = 4;

export function addRequestedAgentId(current, agentId) {
  const ids = [...new Set((current || []).map(String).filter(Boolean))];
  const normalized = String(agentId || "").trim();
  if (!normalized || ids.includes(normalized) || ids.length >= MAX_REQUESTED_AGENTS) return ids;
  return [...ids, normalized];
}

export function pruneRequestedAgentIds(current, text, labelForAgent) {
  const source = String(text || "");
  return [...new Set((current || []).map(String).filter(Boolean))]
    .filter((id) => source.includes(`@${labelForAgent(id)}`))
    .slice(0, MAX_REQUESTED_AGENTS);
}

export function removeRequestedAgentMention(text, label) {
  const source = String(text || "");
  const escaped = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return source;
  return source
    .replace(new RegExp(`@${escaped}(?=\\s|$|[，。！？、,.;:])`, "gu"), "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
}

export function composerDraftMatches(left, right) {
  if (!left || !right) return false;
  const leftIds = Array.isArray(left.requestedAgentIds) ? left.requestedAgentIds.map(String) : [];
  const rightIds = Array.isArray(right.requestedAgentIds) ? right.requestedAgentIds.map(String) : [];
  return String(left.text ?? "").trim() === String(right.text ?? "").trim()
    && leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index]);
}

export function emptyComposerDraft() {
  return { text: "", requestedAgentIds: [] };
}

// 视图标题映射
export const VIEW_TITLES = Object.freeze({
  overview: "系统总览",
  bot: "514 Bot",
  workbench: "协作台",
  team: "团队协作",
  channels: "渠道",
  config: "配置图谱",
  router: "模型路由",
  security: "权限与审批",
  observability: "体系观测",
  sessions: "会话聚合",
  bootstrapper: "项目启动器",
  office: "文档工坊",
  automations: "自动化",
  terminal: "终端",
  market: "插件",
  hosts: "远程主机",
  hero: "协作星图",
  appearance: "外观",
  browser: "浏览器",
});

// 默认组件
export const DEFAULT_COMPONENTS = Object.freeze([
  { id: "control-api", name: "Control API", detail: "/api/bootstrap", status: "pending" },
  { id: "claude", name: "Claude Fable", detail: "规划与统一编排", status: "unknown" },
  { id: "codex", name: "Codex 技术", detail: "实现、评审与验证", status: "unknown" },
  { id: "event-bus", name: "事件总线", detail: "SSE /api/events", status: "pending" },
]);

// 默认模型
export const DEFAULT_MODELS = Object.freeze([
  { role: "规划编排", adapter: "Claude CLI", model: "运行时选择", strengths: ["规划", "编排", "综合"], status: "unknown" },
  { role: "技术", adapter: "Codex CLI", model: "运行时选择", strengths: ["实现", "代码评审", "验证"], status: "unknown" },
  { role: "搜索", adapter: "Grok Search", model: "运行时选择", strengths: ["当前资料", "快速检索"], status: "unknown" },
  { role: "快执行", adapter: "Grok Build", model: "grok-4.5", strengths: ["快执行", "快综合"], status: "unknown" },
  { role: "扩展", adapter: "Pi", model: "运行时选择", strengths: ["RPC", "工具编排"], status: "unknown" },
]);

// 默认策略
export const DEFAULT_POLICIES = Object.freeze([
  { name: "Plan / Review", detail: "只读模式", value: "禁止写入", status: "ok" },
  { name: "Build", detail: "授权工作区内写入", value: "按动作审批", status: "ok" },
  { name: "危险操作", detail: "删除、部署、密钥与系统配置", value: "二次确认", status: "warning" },
  { name: "保护路径", detail: ".env、凭据、.git 与系统目录", value: "默认拒绝", status: "ok" },
]);

// 默认密钥
export const DEFAULT_SECRETS = Object.freeze([
  { name: "Claude Provider", reference: "secret reference", configured: null },
  { name: "Grok Search", reference: "secret reference", configured: null },
  { name: "MCP Connectors", reference: "environment references", configured: null },
]);

/**
 * 全局状态对象
 * 注意：这是可变对象，各模块共享引用。
 * 修改时直接赋值属性，不需要 setter。
 */
export const state = {
  view: "workbench",
  customMacros: [], // W3.11 用户宏（/api/macros；palette 出项 + 原生命令兜底展开）
  bootstrap: {},
  health: null,
  components: [...DEFAULT_COMPONENTS],
  sources: [],
  sourceFilter: "",
  selectedSourceId: null,
  config: null,
  configSurface: "sources",
  // 配置目标（v41 波六）：本机 / SSH 主机 / 远程项目；项目与主机互斥，hostId 仍供运行席位动作复用
  configHostId: null,
  configProjectId: null,
  configHosts: null, // SSH 台账缓存（null=未拉取）
  configHostsError: null,
  configProjectsLoaded: false,
  remoteProjects: [],
  remoteProjectsError: null,
  configHostProbes: new Map(), // hostId → {status:"loading"|"ok"|"error", data?, error?}
  configRemoteMetricHistory: new Map(), // hostId → 最近真实探针样本（有界，不预填虚构历史）
  configHostResult: null, // {targetKey, html} 远程面板内联结果
  configHostGraph: new Map(), // `host:<id>` / `project:<id>` → graph 三态
  configRemoteProviderApps: new Map(), // targetKey → 当前远端供应商应用；主机/项目互不串态
  configRemoteWorkbenchTabs: new Map(), // targetKey → env/proxy/resources/sync/accounts
  configRemoteResourceTabs: new Map(), // targetKey → prompts/mcps/skills/profiles/workspace/backups
  configRemoteRuntimeModes: new Map(), // targetKey → seats/sources
  configRemoteSelectedClis: new Map(), // targetKey → 当前远端 CLI 席位
  configRemoteSyncPlans: new Map(), // hostId → plan 三态；工作台同步页复用
  configRemoteProxyProbes: new Map(), // targetKey → 远端代理环境/监听/出站诊断三态
  configRemoteBusy: new Set(), // `${targetKey}:${action}`，阻止重复发布/探测
  configRemoteRecovery: new Map(), // recoveryKey → 不确定提交证据；同主机写入阻断，显式 reconcile 后解除
  configRemoteRecoveryLoaded: false, // 服务端 dataRoot 恢复账本已成功读取；localStorage 仅作启动缓存
  configRemoteRecoveryLoadError: null, // 账本不可读时所有远端写 fail-closed，避免把未知当作无事务
  configHostSourceOpen: null, // {targetKey, fileId} 当前展开的真源文件
  configHostSourceCache: new Map(), // `${targetKey}:${fileId}` → source 三态
  configHostSourceDrafts: new Map(), // `${targetKey}:${fileId}` → {content,digest,dirty}，目标切换不串草稿
  configRemoteSourceDiffs: new Set(), // `${targetKey}:${fileId}` 已展开保存前差异预览
  configRemoteBackupCompare: new Map(), // `${targetKey}:${fileId}` → 正在对比的备份文件名
  configRemoteBackupCache: new Map(), // `${targetKey}:${fileId}:${name}` → 备份三态（脱敏投影，原文只在服务端）
  configMemberFocusId: null,
  configRuntimeFocusId: null,
  versions: [],
  configVersionPreview: null, // {sourceId,versionId,status,data?,error?}，版本原文/差异 latest-wins
  pendingPlan: null,
  configBusy: false,
  runs: [],
  selectedRunId: null,
  events: [],
  routePreview: null,
  models: [...DEFAULT_MODELS],
  policies: [...DEFAULT_POLICIES],
  secrets: [...DEFAULT_SECRETS],
  approvals: [],
  approvalsLoading: false,
  approvalSnapshotError: null,
  leases: [],
  leaseSnapshotError: null,
  remoteGates: null,
  remoteGatesLoading: false,
  remoteGatesError: null,
  diagnostics: [],
  diagnosticLog: [],
  diagnosticLogFilter: "all",
  cliRuntimeHealth: null, // 安全诊断的 CLI 完整性计数 { broken, upgrade, missing, total } | { error } | null=未检查
  capabilitiesData: null,
  capabilitiesError: null,
  capabilityFilter: "", // Skill 矩阵筛选词；只影响展示与批量作用域，覆盖率统计始终按全集
  capabilityWorkspace: "skills",
  settingsFocus: null,
  capabilityMcpFilter: "all",
  capabilityMcpQuery: "",
  capabilitiesLoading: false,
  providersData: null,
  providersLoading: false,
  editingProviderId: null,
  selectedProviderId: null,
  providerQuery: "",
  // 供应商列表当前聚焦的 app（CC Switch 形态：一次只看一个 app）；app.js 启动时从 localStorage 回填
  providerActiveApp: "claude",
  // cc-switch 二波会话缓存：健康检查/用量/测速结果（不落盘，刷新即重查）
  providerHealth: {}, // id → {status, responseTimeMs, message, testedAt}
  providerUsage: {}, // id → {success, data, error, queriedAt}
  providerLatency: {}, // url → {latency, status, error}
  usageTemplates: null, // GET /api/providers/usage-templates 一次性拉取
  providerPresets: null, // GET /api/providers/presets 一次性拉取（cc-switch 3.18 目录）
  providerPresetQuery: "",
  providerPresetSelected: null, // 预设带入的附加 meta（apiFormat/extraEnv/extraSettings/codexTop/codexProviderExtra/modelCatalog/icon/iconColor）
  providerCodexCatalog: [], // Codex 高级折叠区的模型映射编辑态
  providerOpencodeHeaders: [], // OpenCode options.headers 编辑态 [{key,value}]
  providerOpencodeOptions: [], // OpenCode options 额外项编辑态 [{key,value}]
  providerOpencodeModels: [], // OpenCode models 表编辑态 [{id,name}]
  providerFetchedModels: [], // 当前 Base URL/Key 拉取到的模型建议，仅会话内存态
  providerDeeplinkPreview: null,
  providerDialogTab: "basic",
  providerDialogTargetApp: "claude", // 新建由供应商面板当前应用标签锁定；编辑用于预览与测试
  providerDialogApps: {}, // 新建=仅目标应用；编辑=保留档案原有关联，避免无控件时静默抹除
  providerDialogEndpoints: [], // 对话框内 customEndpoints 编辑暂存
  providerDialogSnapshot: null, // 打开对话框时的表单快照（「重置」回到这里，不必关窗重开）
  // live 热加载：打开对话框时算出的 live↔档案 漂移清单（[{field,label,live,stored}]）。
  // 字段已按 live 预填，这里留档供通知条显示与「改回档案值」一键还原。
  providerDialogLiveDrift: [],
  providerSortMode: false,
  // 本机 live 配置备份台账（GET /api/providers/backups）——与远程备份时间线同形态同操作
  providerBackups: null, // { backups: [...], targets: [...] }
  providerBackupsError: null,
  providerBackupsOpen: false, // 时间线折叠态（默认收起，不抢供应商列表的注意力）
  providerBackupOpenName: null, // 当前展开对比的备份名
  providerBackupCache: new Map(), // name → {status,data,error}
  providerBackupBusy: new Set(), // name（恢复/删除进行中）
  teamChipsPending: null,
  sourceGroupsExpanded: new Set(), // 配置图谱真源树：会话级折叠态（含选中源的组永远自动展开，不入此集）
  runDiffView: null,
  tabs: [],
  activeTabKey: null,
  composerTargetAgentId: null,
  pendingProjects: [],
  agentPickerOpen: false,
  apiState: "pending",
  eventState: "pending",
  eventController: null,
  lastEventSequence: 0,
  streamEpoch: null,
  obsRouteGate: null,
  obsDelta: null,
  obsHandoffs: [],
  obsSummary: null,
  obsOps: null,
  obsDrift: null,
  obsLoaded: false,
  sessionsData: null,
  sessionsError: null,
  projectsData: null,
  expandedProjects: new Set(),
  collapsedRunGroups: new Set(), // 协作会话组默认展开；收起态只存内存（刷新归展开，不持久化噪音偏好）
  collapsedCliGroups: new Set(), // CLI 分组（Claude/Codex…）同纪律：键 `${projectId}:${cli}`，内存态不持久化
  teamTreeCollapsed: false, // Codex 式「项目 ▾」分区头折叠态；持久化在 514cc-rail-groups.team（bindEvents 启动时读回）
  selectionClearedByUser: false, // 显式切新任务模式（selectedRunId=null）的记账：loadRuns 自动选择不得回盖用户意图（LO 2026-08-11）
  showAllSessions: new Set(), // Codex 式「展开显示」：项目 id 集合——在列的项目会话列表不受 TREE_SESSIONS_CAP 截断
  projectSummaries: false,
  showSubagents: false,
  recentOnly: true,
  sessionPreview: null,
  pendingCwd: null,
  pendingRemote: null,
  focusedProjectId: null,
  composerDraftId: globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  composerNewTaskDraft: { text: "", requestedAgentIds: [] },
  composerRunDrafts: Object.create(null),
  attachmentContexts: new Map(),
  activeAttachmentContextKey: null,
  attachments: [],
  attachmentUploads: [],
  projectPrefs: { revision: 0, projects: {}, sessions: {} },
  projectPrefsStatus: "idle",
  projectPrefsError: null,
  runEvents: Object.create(null),
  deepLinkRunId: null,
  deepLinkSession: null,
  deepLinkProjectId: null,
  expandedPinnedProjects: new Set(),
  expandedTeams: new Set(),
  expandedTeamsInitialized: false,
  archivedExpanded: false,
  previewSeq: 0,
  projectsSeq: 0,
  teams: [],
  wallpaperPickerPending: null, // { kind: "preset"|"custom", value }：壁纸弹窗点选后的待应用选择，弹窗确认时消费
  teamStoreStatus: null,
  selectedTeamId: "team-514cc",
  editingTeamId: null,
  teamSurface: "orchestration",
  memberCatalog: [],
  operatorProfile: { label: "AEMEATH", avatar: "" },
  runtimeCatalog: [],
  adapterTemplatesData: null,
  runtimeSeatsData: null,
  runtimeSeatsLoading: false,
  selectedRuntimeSeatId: null,
  runtimeWorkspaceMode: "seats",
  selectedMemberId: null,
  recoveryAckRunId: null,
  automations: [],
  automationStatus: { state: "loading", writable: false, failClosed: false, code: null, message: null },
  automationModelCatalogs: {}, // profileId → { source, models }：CLI 动态发现结果，静态 modelOptions 的补齐/覆盖
  commandPaletteQuery: "",
  commandPaletteActions: [],
  commandPaletteIndex: -1,
  mentionActive: false,
  mentionCandidates: [],
  mentionIndex: -1,
  mentionRange: null,
  requestedAgentIds: [],
  slashActive: false,
  slashCandidates: [],
  slashIndex: -1,
  slashRange: null,
  pendingNativeCommand: false, // 显式标记下一提交为 CLI 原生斜杠命令轮（/compact 等，裸命令直进 CLI）
  agentControlCatalog: null,
  composerCliOpen: false,
  composerCliTab: "commands",
  composerControlDrafts: new Map(),
  editingMessage: null, // 历史消息编辑态 { key, runId, priorDraft }：composer 顶条提示，取消恢复原草稿
  composerCliActionStates: new Map(),
  welcomeCategory: "all",
  usageDays: 7,
  usageSource: "proxy",
  usageChartKind: "bar",
  usageChartMetric: "requests",
  usageLedger: "logs",
  usageModel: "",
  usageProxy: null,
};
