/**
 * channels-panel.js — 渠道工作台：类型向导 + 创建前验通 + 接入清单 + 事件时间线。
 */
import { request, apiReady } from "./api.js";
import { lucideIcon } from "./lucide.js";

const TYPE_META = {
  telegram: {
    icon: "send",
    label: "Telegram Bot",
    blurb: "把群消息收进控制面，也能把测试话推回去。",
    fields: [
      { key: "token", label: "Bot Token", secret: true, placeholder: "123456:AA..." },
      { key: "chatId", label: "对话 chatId（可选）", placeholder: "先对 bot 说一句话会自动记住" },
    ],
    outbound: true,
    steps: [
      "在 Telegram 找 @BotFather，发 /newbot，把 token 贴到左边。",
      "点「验通」会打 getMe。成功会显示 bot 用户名，token 不会进日志。",
      "创建后把 bot 拉进群或私聊，对它说一句话。事件流会出现 chatId，之后就能发测试。",
    ],
  },
  webhook_out: {
    icon: "webhook",
    label: "出站 Webhook",
    blurb: "控制面向外推一条 JSON，可带 HMAC 签名。",
    fields: [
      { key: "url", label: "目标 URL", placeholder: "https://hooks.example.com/514" },
      { key: "secret", label: "签名 Secret（可选）", secret: true, generate: true, placeholder: "接收方用同一把钥匙验签" },
    ],
    outbound: true,
    steps: [
      "填对方能接收 POST 的 http(s) 地址。",
      "需要验签就生成 Secret。我们会带 x-signature-sha256。",
      "「验通」会先打一发探测 JSON，对方回 2xx 再创建更稳。",
    ],
  },
  webhook_in: {
    icon: "satellite-dish",
    label: "入站 Webhook",
    blurb: "给外部一条带签名的入口，事件进时间线。",
    fields: [
      { key: "secret", label: "验签 Secret", secret: true, generate: true, placeholder: "至少 8 位，创建后可复制入站地址" },
    ],
    outbound: false,
    steps: [
      "生成或自填验签 Secret，至少 8 位。",
      "创建后复制入站地址。对方 POST 原文，头里带 x-signature-sha256。",
      "限流 60 次/分钟。签名不对会 401，不会假装收下。",
    ],
  },
};

const state = {
  channels: [],
  events: [],
  formType: "telegram",
  formName: "",
  formConfig: {}, // 字段值快照：渠道卡操作触发全量重渲时不丢用户正在填的内容
  formMsg: "",
  formTone: "",
  probe: null,
  pending: false,
  confirmDeleteId: "",
  eventFilter: "all",
};

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function randomSecret() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function inboundUrl(channel) {
  const path = channel.inboundPath || `/api/channels/webhook/${channel.id}`;
  return `${window.location.origin}${path}`;
}

function lastEventFor(channelId) {
  return state.events.find((event) => event.channelId === channelId) || null;
}

function eventLine(event) {
  if (event.text) return event.text;
  if (event.message) return event.message;
  if (event.status) return `HTTP ${event.status}`;
  if (event.bytes) return `${event.bytes} bytes`;
  return "";
}

function readForm(root) {
  const name = root.querySelector("#channel-name")?.value?.trim() ?? state.formName;
  const config = {};
  for (const field of TYPE_META[state.formType].fields) {
    const el = root.querySelector(`#channel-field-${field.key}`);
    config[field.key] = el ? el.value.trim() : (state.formConfig[field.key] ?? "");
  }
  state.formName = name;
  state.formConfig = config;
  return { name, config };
}

// latest-wins 门闩：启动引导与视图进入两条路径都会触发 refresh，旧响应不得覆盖新响应
let refreshSeq = 0;
async function refresh(root) {
  const seq = ++refreshSeq;
  try {
    const [channels, events] = await Promise.all([
      request("/api/channels"),
      request("/api/channels/events?limit=40"),
    ]);
    if (seq !== refreshSeq) return;
    state.channels = channels?.channels ?? [];
    state.events = events?.events ?? [];
  } catch (error) {
    if (seq !== refreshSeq) return;
    if (/REMOTE_GATE/.test(error.message || "")) {
      root.innerHTML = `
        <div class="channel-empty">
          ${lucideIcon("lock", "icon lucide")}
          <h2>渠道门闸未开放</h2>
          <p>${esc(error.message)}</p>
          <button type="button" class="button secondary" id="channel-retry">${lucideIcon("rotate-ccw", "icon lucide")} 授权后重试</button>
        </div>`;
      root.querySelector("#channel-retry")?.addEventListener("click", () => void refresh(root));
      return;
    }
    state.channels = [];
    state.events = [];
    state.formMsg = `读取失败：${error.message}`;
    state.formTone = "error";
  }
  render(root);
}

function render(root) {
  const meta = TYPE_META[state.formType];
  const filteredEvents = state.events.filter((event) => state.eventFilter === "all" || event.kind === state.eventFilter);
  root.innerHTML = `
    <section class="channel-deck" aria-labelledby="channel-wizard-title">
      <header class="channel-deck-head">
        <div>
          <span class="eyebrow">Connect</span>
          <h2 id="channel-wizard-title">接入向导</h2>
        </div>
        <p class="channel-deck-lead">先选一种入口，验通后再创建。密钥只活在本机渠道账本里，列表里永远是掩码。</p>
      </header>

      <div class="channel-type-grid" role="tablist" aria-label="渠道类型">
        ${Object.entries(TYPE_META).map(([type, item]) => `
          <button type="button" class="channel-type-card ${state.formType === type ? "is-active" : ""}" data-channel-type="${type}" role="tab" aria-selected="${state.formType === type}">
            <span class="channel-type-icon">${lucideIcon(item.icon, "icon lucide")}</span>
            <strong>${item.label}</strong>
            <span>${item.blurb}</span>
          </button>`).join("")}
      </div>

      <div class="channel-wizard">
        <form class="channel-form" id="channel-form">
          <label class="channel-field">名称
            <input class="input" id="channel-name" type="text" value="${esc(state.formName)}" placeholder="例如：运维通知群" />
          </label>
          ${meta.fields.map((field) => `
            <label class="channel-field">${field.label}
              <span class="channel-field-row">
                <input class="input" id="channel-field-${field.key}" type="${field.secret ? "password" : "text"}" autocomplete="off" value="${esc(state.formConfig[field.key] ?? "")}" placeholder="${esc(field.placeholder || "")}" />
                ${field.generate ? `<button type="button" class="button secondary" data-generate-secret="${field.key}">${lucideIcon("key-round", "icon lucide")} 生成</button>` : ""}
              </span>
            </label>`).join("")}
          <div class="channel-form-actions">
            <button type="button" class="button secondary" id="channel-probe" ${state.pending ? "disabled" : ""}>
              ${lucideIcon("sparkles", "icon lucide")} 验通
            </button>
            <button type="submit" class="button primary" id="channel-create" ${state.pending ? "disabled" : ""}>
              ${lucideIcon("plus", "icon lucide")} 创建渠道
            </button>
          </div>
          <p class="channel-form-msg ${state.formTone ? `is-${state.formTone}` : ""}" id="channel-form-msg">${esc(state.formMsg)}</p>
        </form>
        <aside class="channel-guide" aria-label="${meta.label} 步骤">
          <h3>${lucideIcon("book-open", "icon lucide")} ${meta.label} 怎么接</h3>
          <ol>
            ${meta.steps.map((step) => `<li>${step}</li>`).join("")}
          </ol>
          ${state.probe?.ok && state.formType === "telegram" && state.probe.detail?.username
            ? `<p class="channel-probe-ok">${lucideIcon("circle-check", "icon lucide")} 已认出 @${esc(state.probe.detail.username)}</p>`
            : ""}
        </aside>
      </div>
    </section>

    <section class="channel-section" aria-labelledby="channel-list-title">
      <h2 class="waveg-section-title" id="channel-list-title">${lucideIcon("satellite-dish", "icon lucide")} 已接入 ${state.channels.length ? `<span class="channel-count">${state.channels.length}</span>` : ""}</h2>
      <div class="waveg-grid">
        ${state.channels.map((channel) => renderChannelCard(channel)).join("") || `
          <div class="channel-empty">
            ${lucideIcon("satellite-dish", "icon lucide")}
            <h3>还没有渠道</h3>
            <p>从上面的向导接第一条。Telegram 适合人话进出，Webhook 适合系统和系统对接。</p>
          </div>`}
      </div>
    </section>

    <section class="channel-section" aria-labelledby="channel-events-title">
      <div class="channel-section-head">
        <h2 class="waveg-section-title" id="channel-events-title">${lucideIcon("activity", "icon lucide")} 最近事件</h2>
        <div class="channel-filter" role="group" aria-label="事件过滤">
          ${["all", "inbound", "outbound", "error"].map((kind) => `
            <button type="button" class="channel-filter-btn ${state.eventFilter === kind ? "is-active" : ""}" data-event-filter="${kind}">
              ${kind === "all" ? "全部" : kind === "inbound" ? "入站" : kind === "outbound" ? "出站" : "错误"}
            </button>`).join("")}
        </div>
      </div>
      <div class="channel-events">
        ${filteredEvents.map((event) => `
          <article class="channel-event is-${esc(event.kind || "event")}">
            <span class="waveg-badge ${event.kind === "error" ? "is-warn" : event.kind === "inbound" ? "is-on" : ""}">${esc(event.kind || "event")}</span>
            <div>
              <strong>${esc(TYPE_META[event.type]?.label || event.type)}</strong>
              <span>${esc(event.channelId)} · ${esc(event.at || "")}</span>
              ${eventLine(event) ? `<p>${esc(eventLine(event))}</p>` : ""}
            </div>
          </article>`).join("") || `
          <div class="channel-empty is-compact">
            ${lucideIcon("activity", "icon lucide")}
            <h3>暂无事件</h3>
            <p>验通、发测试或外部 POST 进来后，这里会按时间倒序出现。</p>
          </div>`}
      </div>
    </section>`;

  bind(root);
}

function renderChannelCard(channel) {
  const typeMeta = TYPE_META[channel.type] ?? { icon: "webhook", label: channel.type };
  const latest = lastEventFor(channel.id);
  const confirming = state.confirmDeleteId === channel.id;
  const inbound = channel.type === "webhook_in" ? inboundUrl(channel) : "";
  return `
    <article class="waveg-card channel-card">
      <div class="waveg-card-head">
        ${lucideIcon(typeMeta.icon, "icon lucide")}
        <h3>${esc(channel.name)}</h3>
        <span class="waveg-badge ${channel.enabled ? "is-on" : ""}">${channel.enabled ? "已启用" : "停用"}</span>
      </div>
      <dl class="waveg-kv">
        <dt>类型</dt><dd>${typeMeta.label}</dd>
        ${channel.config?.chatId ? `<dt>chatId</dt><dd>${esc(channel.config.chatId)}</dd>` : ""}
        ${inbound ? `<dt>入站</dt><dd>${esc(inbound)}</dd>` : ""}
        ${channel.config?.url && channel.config.url !== "***" ? `<dt>目标</dt><dd>${esc(channel.config.url)}</dd>` : ""}
      </dl>
      ${latest ? `<p class="channel-card-pulse">${esc(latest.kind)} · ${esc(eventLine(latest) || latest.at || "")}</p>` : `<p class="channel-card-pulse">还没有事件</p>`}
      ${channel.type === "telegram" ? `
        <label class="channel-field">发测试用的 chatId
          <input class="input" data-channel-chat="${esc(channel.id)}" value="${esc(channel.config?.chatId || "")}" placeholder="对 bot 说话后会自动填" />
        </label>` : ""}
      <div class="waveg-card-actions">
        <button type="button" class="button secondary" data-channel-toggle="${esc(channel.id)}" data-enabled="${channel.enabled}">
          ${lucideIcon(channel.enabled ? "circle-stop" : "play", "icon lucide")} ${channel.enabled ? "停用" : "启用"}
        </button>
        ${typeMeta.outbound ? `<button type="button" class="button secondary" data-channel-test="${esc(channel.id)}">${lucideIcon("send", "icon lucide")} 发测试</button>` : ""}
        ${inbound ? `<button type="button" class="button secondary" data-copy="${esc(inbound)}">${lucideIcon("copy", "icon lucide")} 复制入站地址</button>` : ""}
        ${confirming
          ? `<button type="button" class="button" data-channel-delete-cancel>取消</button>
             <button type="button" class="button button-danger" data-channel-delete="${esc(channel.id)}">${lucideIcon("trash-2", "icon lucide")} 确认删除</button>`
          : `<button type="button" class="button secondary" data-channel-delete-ask="${esc(channel.id)}">${lucideIcon("trash-2", "icon lucide")} 删除</button>`}
      </div>
      ${inbound ? `<pre class="channel-curl">curl -X POST ${esc(inbound)} -H "content-type: application/json" -H "x-signature-sha256: &lt;hmac&gt;" --data '{"ping":true}'</pre>` : ""}
    </article>`;
}

function bind(root) {
  root.querySelectorAll("[data-channel-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.formType = button.dataset.channelType;
      state.probe = null;
      state.formMsg = "";
      state.formTone = "";
      render(root);
    });
  });
  root.querySelectorAll("[data-generate-secret]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = root.querySelector(`#channel-field-${button.dataset.generateSecret}`);
      if (input) input.value = randomSecret();
    });
  });
  root.querySelector("#channel-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createChannel(root);
  });
  // 输入即快照：任何全量重渲（渠道卡操作/事件过滤）都能回填用户已填内容
  root.querySelector("#channel-form")?.addEventListener("input", (event) => {
    readForm(root);
    // 密钥/token 改动即失效旧验通：就地摘除「已认出 @bot」指示，不整树重渲（保输入焦点）
    if (/token|secret/i.test(event.target?.id ?? "") && state.probe) {
      state.probe = null;
      root.querySelector(".channel-probe-ok")?.remove();
    }
  });
  root.querySelector("#channel-probe")?.addEventListener("click", () => void probeChannel(root));
  root.querySelectorAll("[data-channel-toggle]").forEach((button) => {
    button.addEventListener("click", () => void toggleChannel(root, button.dataset.channelToggle, button.dataset.enabled !== "true"));
  });
  root.querySelectorAll("[data-channel-test]").forEach((button) => {
    button.addEventListener("click", () => void testChannel(root, button.dataset.channelTest));
  });
  root.querySelectorAll("[data-channel-delete-ask]").forEach((button) => {
    button.addEventListener("click", () => {
      state.confirmDeleteId = button.dataset.channelDeleteAsk;
      render(root);
    });
  });
  root.querySelector("[data-channel-delete-cancel]")?.addEventListener("click", () => {
    state.confirmDeleteId = "";
    render(root);
  });
  root.querySelectorAll("[data-channel-delete]").forEach((button) => {
    button.addEventListener("click", () => void deleteChannel(root, button.dataset.channelDelete));
  });
  root.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const ok = await copyText(button.dataset.copy);
      state.formMsg = ok ? "入站地址已复制" : "复制失败，请手动选中地址";
      state.formTone = ok ? "ok" : "error";
      const msg = root.querySelector("#channel-form-msg");
      if (msg) {
        msg.textContent = state.formMsg;
        msg.className = `channel-form-msg is-${state.formTone}`;
      }
    });
  });
  root.querySelectorAll("[data-event-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.eventFilter = button.dataset.eventFilter;
      render(root);
    });
  });
}

function setBusy(root, busy) {
  state.pending = busy;
  root.querySelector("#channel-probe")?.toggleAttribute("disabled", busy);
  root.querySelector("#channel-create")?.toggleAttribute("disabled", busy);
}

function setFormMessage(root, text, tone = "") {
  state.formMsg = text;
  state.formTone = tone;
  const el = root.querySelector("#channel-form-msg");
  if (el) {
    el.textContent = text;
    el.className = `channel-form-msg${tone ? ` is-${tone}` : ""}`;
  }
}

async function probeChannel(root) {
  const { config } = readForm(root);
  setBusy(root, true);
  setFormMessage(root, "正在验通…");
  try {
    const result = await request("/api/channels/probe", {
      method: "POST",
      body: JSON.stringify({ type: state.formType, config }),
    });
    state.probe = result;
    if (result?.ok && state.formType === "telegram" && result.detail?.username) {
      setFormMessage(root, `验通成功：@${result.detail.username}`, "ok");
    } else if (result?.ok) {
      setFormMessage(root, state.formType === "webhook_out"
        ? `探测已发出，对方返回 HTTP ${result.status ?? "?"}`
        : "验签 Secret 已就绪，可以创建", "ok");
    } else {
      setFormMessage(root, `验通未通过：HTTP ${result?.status ?? "?"}`, "error");
    }
  } catch (error) {
    state.probe = null;
    setFormMessage(root, `验通失败：${error.message}`, "error");
  } finally {
    setBusy(root, false);
  }
}

async function createChannel(root) {
  const { name, config } = readForm(root);
  // 与服务端同口径的预检：跳过验通直接创建也尽早给出可读错误
  if (state.formType === "webhook_in" && String(config.secret ?? "").trim().length < 8) {
    setFormMessage(root, "验签 Secret 至少 8 位", "error");
    return;
  }
  setBusy(root, true);
  try {
    await request("/api/channels", { method: "POST", body: JSON.stringify({ type: state.formType, name, config, enabled: true }) });
    state.formName = "";
    state.probe = null;
    state.formMsg = "渠道已创建";
    state.formTone = "ok";
  } catch (error) {
    setFormMessage(root, `创建失败：${error.message}`, "error");
    return;
  } finally {
    // 成功路径此前不落 false：render() 按 state.pending 发 disabled，向导会永久锁死
    setBusy(root, false);
  }
  await refresh(root);
}

async function toggleChannel(root, id, enabled) {
  try {
    await request(`/api/channels/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });
  } catch (error) {
    setFormMessage(root, `切换失败：${error.message}`, "error");
  }
  await refresh(root);
}

async function testChannel(root, id) {
  const channel = state.channels.find((item) => item.id === id);
  const chatId = root.querySelector(`[data-channel-chat="${id}"]`)?.value?.trim() || "";
  try {
    if (channel?.type === "telegram") {
      if (!chatId) {
        setFormMessage(root, "先填 chatId，或对 bot 说一句话让它记住", "error");
        return;
      }
      await request(`/api/channels/${id}`, { method: "PUT", body: JSON.stringify({ config: { chatId } }) });
    }
    const result = await request(`/api/channels/${id}/test`, {
      method: "POST",
      body: JSON.stringify({ text: "514 Bot 渠道连通性测试", chatId }),
    });
    setFormMessage(root, result?.ok ? "测试已发出" : `测试未成功：HTTP ${result?.status ?? "?"}`, result?.ok ? "ok" : "error");
  } catch (error) {
    setFormMessage(root, `测试失败：${error.message}`, "error");
  }
  await refresh(root);
}

async function deleteChannel(root, id) {
  try {
    await request(`/api/channels/${id}`, { method: "DELETE" });
    state.confirmDeleteId = "";
  } catch (error) {
    setFormMessage(root, `删除失败：${error.message}`, "error");
  }
  await refresh(root);
}

/** 供 app.js 在切入视图时按需刷新（门闸授权后切回不再是死屏）。 */
export function refreshChannelsPanel(rootOverride = null) {
  const root = rootOverride || document.getElementById("channels-container");
  if (root) void refresh(root);
}

function bootWhenReady() {
  if (typeof document === "undefined") return;
  const start = () => void apiReady.then(() => {
    const root = document.getElementById("channels-container");
    if (root) void refresh(root);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

bootWhenReady();
