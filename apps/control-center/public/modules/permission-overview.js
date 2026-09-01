const APPROVAL_CHANNELS = Object.freeze({
  "broker-action": Object.freeze({ label: "514cc 动作审批", tone: "ok", detail: "适配器可把受支持的动作请求交给 ApprovalBroker。" }),
  "governed-build": Object.freeze({ label: "仅 Build 审批", tone: "warning", detail: "写盘由 514cc Build 审批约束；宿主工具审批不进入本队列。" }),
  unavailable: Object.freeze({ label: "无交互审批", tone: "neutral", detail: "当前适配器没有可恢复的交互审批回调。" }),
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function approvalChannel(template) {
  return APPROVAL_CHANNELS[template?.approvalChannel] || APPROVAL_CHANNELS.unavailable;
}

function seatStatus(seat) {
  const live = seat?.live && typeof seat.live === "object" ? seat.live : null;
  if (seat?.enabled !== true) return { label: "已停用", tone: "neutral", ready: false };
  if (!live) return { label: "未激活", tone: "error", ready: false };
  if (seat.activation !== "live") return { label: "待重载", tone: "warning", ready: false };
  if (live.enabled !== true || live.teamMemberEligible !== true) return { label: "不可执行", tone: "error", ready: false };
  return { label: "可执行", tone: "ok", ready: true };
}

export function buildPermissionOverviewModel({
  runtimeSeatsData = null,
  runtimeSeatsLoading = false,
  approvals = [],
  approvalsLoading = false,
  leases = [],
  approvalSnapshotError = null,
  leaseSnapshotError = null,
  remoteGates = null,
  remoteGatesLoading = false,
  remoteGatesError = null,
  apiState = "pending",
  transactionBlocked = false,
  configRecoveryError = null,
  repoRoot = null,
  runtimeGeneration = null,
} = {}) {
  const seats = list(runtimeSeatsData?.seats);
  const templates = new Map(list(runtimeSeatsData?.adapterTemplates).map((template) => [template?.id, template]));
  const runtimeError = runtimeSeatsData?.error || null;
  const seatRows = seats.map((seat) => {
    const status = seatStatus(seat);
    const channel = approvalChannel(templates.get(seat?.live?.adapter || seat?.adapter));
    return {
      id: text(seat?.id, "unknown-seat"),
      label: text(seat?.label, text(seat?.id, "未命名席位")),
      adapter: text(seat?.live?.adapterLabel, text(templates.get(seat?.adapter)?.label, text(seat?.adapter, "未知 Adapter"))),
      configuredPermission: text(seat?.defaultPermissionMode, "未声明"),
      activePermission: text(seat?.live?.defaultPermissionMode, "未激活"),
      activation: status.label,
      activationTone: status.tone,
      ready: status.ready,
      approvalChannel: channel.label,
      approvalTone: channel.tone,
      approvalDetail: channel.detail,
    };
  });
  const readySeats = seatRows.filter((seat) => seat.ready).length;
  const pendingApprovals = list(approvals).filter((item) => (item?.status ?? "pending") === "pending");
  const openLeases = list(leases).filter((item) => item?.gateOpen === true);
  const gates = list(remoteGates);
  const openGates = gates.filter((gate) => gate?.status === "open");
  const brokerSeats = seatRows.filter((seat) => seat.ready && seat.approvalChannel === APPROVAL_CHANNELS["broker-action"].label).length;
  const buildOnlySeats = seatRows.filter((seat) => seat.ready && seat.approvalChannel === APPROVAL_CHANNELS["governed-build"].label).length;
  const unavailableSeats = seatRows.filter((seat) => seat.ready && seat.approvalChannel === APPROVAL_CHANNELS.unavailable.label).length;
  const blockers = [
    runtimeError && `运行席位快照：${text(runtimeError)}`,
    approvalSnapshotError && `审批快照：${text(approvalSnapshotError)}`,
    leaseSnapshotError && `租约快照：${text(leaseSnapshotError)}`,
    remoteGatesError && `远程门闩：${text(remoteGatesError)}`,
    transactionBlocked && "配置事务：存在未决事务",
    configRecoveryError && `远端配置恢复账本：${text(configRecoveryError)}`,
  ].filter(Boolean);
  const blocked = blockers.length > 0;
  const loading = Boolean(runtimeSeatsLoading || approvalsLoading || remoteGatesLoading);
  const seatValue = runtimeSeatsLoading ? "读取中" : runtimeError ? "读取失败" : runtimeSeatsData ? `${readySeats}/${seatRows.length} 已激活可执行` : "尚未读取";
  const approvalValue = approvalsLoading ? "读取中" : approvalSnapshotError || leaseSnapshotError ? "读取失败" : `${pendingApprovals.length} 项待处理`;
  const temporaryValue = remoteGatesLoading ? "读取中" : remoteGatesError ? "读取失败" : `${openLeases.length} 个租约 · ${openGates.length} 面门闩`;
  const channelValue = runtimeSeatsLoading || !runtimeSeatsData ? "尚未核对" : `${brokerSeats} 席可桥接`;

  return {
    blocked,
    loading,
    summary: blocked
      ? { label: `${blockers.length} 项阻断`, tone: "error" }
      : loading
        ? { label: "正在核对", tone: "neutral" }
        : pendingApprovals.length
          ? { label: `${pendingApprovals.length} 项待处理`, tone: "warning" }
          : apiState === "ok"
            ? { label: "权限状态已核对", tone: "ok" }
            : { label: "状态未知", tone: "neutral" },
    cards: [
      { id: "seats", label: "运行席位权限", value: seatValue, tone: runtimeError ? "error" : runtimeSeatsLoading || !runtimeSeatsData ? "neutral" : readySeats ? "ok" : "warning", detail: runtimeError ? text(runtimeError, "运行席位读取失败") : "严格按已激活且服务端确认可执行的席位计数。" },
      { id: "approvals", label: "514cc 项目内审批", value: approvalValue, tone: approvalSnapshotError || leaseSnapshotError ? "error" : approvalsLoading ? "neutral" : pendingApprovals.length ? "warning" : "ok", detail: approvalSnapshotError || leaseSnapshotError ? text(approvalSnapshotError || leaseSnapshotError, "审批状态不可读") : "批准与拒绝继续绑定服务端 actionSha256。" },
      { id: "temporary", label: "临时授权 / 高风险面", value: temporaryValue, tone: remoteGatesError ? "error" : remoteGatesLoading ? "neutral" : openLeases.length || openGates.length ? "warning" : "ok", detail: remoteGatesError ? text(remoteGatesError, "门闩状态不可读") : "租约与门闩均为临时状态，默认 fail-closed。" },
      { id: "channels", label: "适配器审批通道", value: channelValue, tone: runtimeSeatsLoading || !runtimeSeatsData ? "neutral" : brokerSeats ? "ok" : "warning", detail: runtimeSeatsData ? `${buildOnlySeats} 席仅支持 Build 审批 · ${unavailableSeats} 席无交互回调；宿主 SDK 审批不会伪装为项目内审批。` : "等待运行席位目录。" },
    ],
    seatRows,
    blockers,
    instance: {
      repoRoot: text(repoRoot, "实例路径未返回"),
      runtimeGeneration: runtimeGeneration !== null && runtimeGeneration !== "" && Number.isSafeInteger(Number(runtimeGeneration)) ? Number(runtimeGeneration) : null,
    },
  };
}

function node(tag, className = "", content = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== "") element.textContent = String(content);
  return element;
}

function emptyNode(title, detail) {
  const root = node("div", "empty-state compact-empty-state");
  root.append(node("strong", "", title), node("span", "", detail));
  return root;
}

function factNode(label, value, { tone = null, title = "" } = {}) {
  const root = document.createElement("div");
  const term = node("dt", "", label);
  const detail = document.createElement("dd");
  if (tone) detail.append(node("span", `status-label is-${tone}`, value));
  else detail.textContent = String(value);
  if (title) detail.title = title;
  root.append(term, detail);
  return root;
}

function settingsIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon lucide");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#lucide-settings");
  svg.append(use);
  return svg;
}

export function paintPermissionOverview({ host, summary, instance, blockers, seatList, model, seatsLoading = false } = {}) {
  if (!host || !model) return;
  host.setAttribute("aria-busy", String(model.loading));
  host.replaceChildren(...model.cards.map((card) => {
    const article = node("article", `permission-overview-card is-${card.tone}`);
    article.dataset.permissionCard = card.id;
    article.append(node("span", "", card.label), node("strong", "", card.value), node("small", "", card.detail));
    return article;
  }));

  if (summary) {
    summary.textContent = model.summary.label;
    summary.className = `status-label is-${model.summary.tone}`;
  }
  if (instance) {
    const path = node("code", "", model.instance.repoRoot);
    path.title = model.instance.repoRoot;
    instance.replaceChildren(
      node("span", "", "当前实例"),
      path,
      node("small", "", `runtime generation ${model.instance.runtimeGeneration ?? "未知"}`),
    );
  }
  if (blockers) {
    blockers.hidden = model.blockers.length === 0;
    if (model.blockers.length) {
      const list = document.createElement("ul");
      list.append(...model.blockers.map((item) => node("li", "", item)));
      blockers.replaceChildren(node("strong", "", "当前阻断"), list);
    } else {
      blockers.replaceChildren();
    }
  }
  if (!seatList) return;
  seatList.setAttribute("aria-busy", String(seatsLoading));
  if (seatsLoading) {
    seatList.replaceChildren(emptyNode("正在读取运行席位", "旧快照已退出权限计数"));
    return;
  }
  if (model.cards.find((card) => card.id === "seats")?.tone === "error") {
    seatList.replaceChildren(emptyNode("运行席位读取失败", model.cards.find((card) => card.id === "seats")?.detail || "状态不可读"));
    return;
  }
  if (!model.seatRows.length) {
    seatList.replaceChildren(emptyNode("没有运行席位", "在配置图谱中创建或恢复运行席位"));
    return;
  }
  seatList.replaceChildren(...model.seatRows.map((seat) => {
    const article = node("article", "permission-seat-row");
    article.dataset.permissionSeat = seat.id;
    const main = node("div", "permission-seat-main");
    main.append(node("strong", "", seat.label), node("span", "", seat.adapter));
    const facts = node("dl", "permission-seat-facts");
    facts.append(
      factNode("配置声明", seat.configuredPermission),
      factNode("当前激活", seat.activePermission),
      factNode("运行状态", seat.activation, { tone: seat.activationTone }),
      factNode("审批通道", seat.approvalChannel, { title: seat.approvalDetail }),
    );
    const button = node("button", "icon-button");
    button.type = "button";
    button.dataset.configSurfaceJump = "sources";
    button.dataset.runtimeSeatId = seat.id;
    button.title = "编辑运行席位";
    button.setAttribute("aria-label", `编辑运行席位 ${seat.label}`);
    button.append(settingsIcon());
    article.append(main, facts, button);
    return article;
  }));
}
