import { ClaudeCliAdapter } from "./claude-cli.mjs";
import { CodexAppServerAdapter } from "./codex-app-server.mjs";
import { CodexCliAdapter } from "./codex-cli.mjs";
import { GeminiCliAdapter } from "./gemini-cli.mjs";
import { GrokBuildAdapter } from "./grok-build.mjs";
import { GrokMcpAdapter } from "./grok-mcp.mjs";
import { KimiCliAdapter } from "./kimi-cli.mjs";
import { OpencodeCliAdapter } from "./opencode-cli.mjs";
import { PiRpcAdapter } from "./pi-rpc.mjs";
import { ADAPTER_TEMPLATES, createTeamCatalog, resolveAdapterTemplate, resolveProviderBinding } from "./manifest.mjs";
import { resolve } from "node:path";
import { assertWithin } from "../paths.mjs";

function manifestError(message) {
  return Object.assign(new Error(message), { code: "ADAPTER_MANIFEST_INVALID" });
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function assertAdapterKeySpace(profiles) {
  const primaryKeys = new Set(profiles.map((profile) => profile.id));
  const fallbackOwners = new Map();
  const collisions = [];
  for (const profile of profiles) {
    const { adapterTemplate } = resolveAdapterTemplate(profile);
    if (!adapterTemplate.fallbackFactoryKey) continue;
    const fallbackKey = `${profile.id}-fallback`;
    if (primaryKeys.has(fallbackKey)) collisions.push(`${fallbackKey} (primary and fallback for ${profile.id})`);
    const previousOwner = fallbackOwners.get(fallbackKey);
    if (previousOwner) collisions.push(`${fallbackKey} (fallback for ${previousOwner} and ${profile.id})`);
    else fallbackOwners.set(fallbackKey, profile.id);
  }
  if (collisions.length) {
    throw manifestError(`runtime adapter keys collide: ${collisions.join(", ")}`);
  }
}

async function withProviderProjection(providerStore, app, providerIdOrResolver, operation) {
  if (typeof providerStore?.withProviderProjection !== "function") {
    throw manifestError("provider store does not implement serialized execution projection");
  }
  return providerStore.withProviderProjection(app, providerIdOrResolver, operation);
}

function providerBindingDescriptor(profile, adapterTemplate, providerStore) {
  const requestedProviderId = profile.providerId == null ? null : String(profile.providerId).trim() || null;
  const resolved = resolveProviderBinding(profile, adapterTemplate, providerStore);
  const providerApp = adapterTemplate.providerApp || null;
  const proxyTakeover = Boolean(
    resolved.providerId
    && providerApp
    && providerStore?.proxyRuntime?.takeover?.has?.(providerApp),
  );
  const routeMode = resolved.providerId
    ? (proxyTakeover ? "local-proxy" : "direct-projection")
    : "adapter-managed";
  return Object.freeze({
    requestedProviderId,
    effectiveProviderId: resolved.providerId,
    mode: resolved.providerId ? "bound" : "adapter-managed",
    degradedReason: resolved.degraded?.reason || null,
    degradedDetail: resolved.degraded
      ? Object.freeze({ ...resolved.degraded })
      : null,
    providerApp,
    adapterId: adapterTemplate.id,
    routeMode,
    bindingScope: resolved.providerId ? (proxyTakeover ? "dispatch" : "upstream") : "adapter",
    upstreamProviderId: resolved.providerId && !proxyTakeover ? resolved.providerId : null,
    upstreamAttribution: resolved.providerId
      ? (proxyTakeover ? "proxy-request-unlinked" : "exact")
      : "unavailable",
  });
}

function attachProviderBindingResolver(adapter, resolver) {
  Object.defineProperty(adapter, "getProviderBinding", {
    configurable: false,
    enumerable: false,
    value: resolver,
    writable: false,
  });
  return adapter;
}

function bindProvider(adapter, profile, adapterTemplate, providerStore) {
  const requestedProviderId = String(profile.providerId ?? "").trim();
  const getBinding = () => providerBindingDescriptor(profile, adapterTemplate, providerStore);
  attachProviderBindingResolver(adapter, getBinding);
  if (!requestedProviderId) return adapter;
  // Provider 状态可能在运行期间恢复或失效；每次 send 动态重解析，避免启动期快照
  // 把 continuation 永久锁在旧的 adapter-managed/bound 语义。
  const app = adapterTemplate.providerApp;
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "getProviderBinding") return getBinding;
      if (property === "send") {
        return async (input) => {
          let binding = null;
          let operationStarted = false;
          try {
            const response = await withProviderProjection(
              providerStore,
              app,
              () => {
                binding = getBinding();
                return binding.mode === "bound" ? binding.effectiveProviderId : null;
              },
              () => {
                operationStarted = true;
                return target.send(input);
              },
            );
            binding ??= getBinding();
            return { ...response, providerBinding: binding };
          } catch (error) {
            const currentBinding = getBinding();
            // ProviderStore 解析出 id 后，更新/删除仍可能在切换 live 投影前提交。
            // 只有确认投影尚未开始且绑定已明确降级时，才允许沿用 LO 裁决的
            // adapter-managed 语义重试；不能把真实 adapter.send 错误吞成降级。
            if (
              !operationStarted
              && currentBinding.mode === "adapter-managed"
              && (error?.code === "SOURCE_NOT_FOUND" || error?.code === "VALIDATION_FAILED")
            ) {
              binding = currentBinding;
              try {
                const response = await target.send(input);
                return { ...response, providerBinding: binding };
              } catch (retryError) {
                if (retryError && typeof retryError === "object" && !retryError.providerBinding) {
                  retryError.providerBinding = binding;
                }
                throw retryError;
              }
            }
            binding ??= currentBinding;
            if (error && typeof error === "object" && !error.providerBinding) error.providerBinding = binding;
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// 工厂表抽成共享构建器：本机（createAdapters）与远程 run（createRemoteAdapter，v41 波二）
// 同一张表——remote 注入时给 spawn 型（runProcessImpl）/常驻型（spawnImpl）模板换 SSH 桥实现，
// adapter 清单不两处漂移。remote = { spawnImpl, runProcessImpl } | null。
function buildFactoryEntries({ eventStore, cwd, approvalResolver, remote = null }) {
  const injSpawn = (opts) => (remote?.spawnImpl ? { ...opts, spawnImpl: remote.spawnImpl } : opts);
  const injRun = (opts) => (remote?.runProcessImpl ? { ...opts, runProcessImpl: remote.runProcessImpl } : opts);
  // headless 子进程 settings：disableAllHooks 隔离全局 route/stop/mirror-gate（--bare 的替代——保住 OAuth 登录态）
  const claudeSettings = assertWithin(
    cwd,
    resolve(cwd, "config/control-center/claude-headless-settings.json"),
    "Claude headless settings",
  );
  const grokCompatScript = assertWithin(
    cwd,
    resolve(cwd, "scripts/grok_search_chat_compat.mjs"),
    "Grok search compatibility MCP",
  );
  const grokRequiredEnv = [
    "GROK_SEARCH_RS_COMPAT_API_URL",
    "GROK_SEARCH_RS_COMPAT_API_KEY",
    "GROK_SEARCH_RS_COMPAT_MODEL",
  ];
  return [
    ["claude-cli", (profile, adapterTemplate) => new ClaudeCliAdapter(injRun({
      command: profile.command,
      model: profile.model,
      // 远程 run：settings/systemPrompt 是本机路径（远端不存在），如实走远端原生配置——
      // 不把不可达路径写进远端命令行假装隔离（远端 hooks=远端用户自己的环境）
      systemPromptFile: !remote && profile.systemPromptFile
        ? assertWithin(cwd, resolve(cwd, profile.systemPromptFile), "Claude coordinator system prompt")
        : null,
      settingsFile: remote ? null : claudeSettings,
      eventStore,
      cwd,
      // v50 许可通道：仅本机 run 开。远程 run 的 CLI 跑在对端，
      // 本机具名管道对它不可达 —— 与其让它以为有宿主后请求挂到超时，
      // 不如不开（维持既有的"无宿主即拒"行为，如实且有界）。
      approvalResolver: remote ? null : approvalResolver,
    }))],
    ["codex-app-server", (profile, adapterTemplate) => new CodexAppServerAdapter(injSpawn({
      command: profile.command,
      model: profile.model,
      eventStore,
      cwd,
      approvalResolver,
      runtimeProfileId: profile.id,
    }))],
    ["codex-cli", (profile, adapterTemplate) => new CodexCliAdapter(injRun({
      command: profile.command,
      model: profile.model,
      eventStore,
      cwd,
    }))],
    ["gemini-cli", (profile, adapterTemplate) => new GeminiCliAdapter(injRun({
      command: profile.command,
      model: profile.model,
      eventStore,
      cwd,
    }))],
    ["grok-mcp", (profile) => {
      // 安全字段保持代码拥有：自定义席位不能替换 MCP 脚本、server 或 env allowlist。
      const host = new CodexAppServerAdapter({
        command: "codex",
        model: null,
        eventStore,
        cwd,
        approvalResolver,
        disableMcp: true,
        environmentProvider: "grok",
        runtimeProfileId: profile.id,
        environmentAllowlist: grokRequiredEnv,
        mcpServers: [{
          name: "grok-search-rs",
          command: process.execPath,
          args: [grokCompatScript],
          envVars: grokRequiredEnv,
          startupTimeoutSec: 30,
          toolTimeoutSec: 120,
        }],
      });
      return new GrokMcpAdapter({
        host,
        eventStore,
        runtimeProfileId: profile.id,
        requiredEnv: grokRequiredEnv,
      });
    }],
    ["grok-build", (profile) => new GrokBuildAdapter(injRun({ command: profile.command, model: profile.model, eventStore, cwd }))],
    ["kimi-cli", (profile) => new KimiCliAdapter(injRun({ command: profile.command, model: profile.model, eventStore, cwd }))],
    ["opencode-cli", (profile) => new OpencodeCliAdapter(injRun({ command: profile.command, model: profile.model, eventStore, cwd }))],
    ["pi-rpc", (profile) => new PiRpcAdapter(injSpawn({
      command: profile.command,
      model: profile.model,
      effort: profile.defaultEffort,
      eventStore,
      cwd,
    }))],
  ];
}

export function createAdapters({ profiles, eventStore, cwd, approvalResolver, providerStore = null, onProviderDegraded = null }) {
  const duplicateProfiles = duplicates(profiles.map((profile) => profile.id));
  if (duplicateProfiles.length) {
    throw manifestError(`duplicate runtime profile ids: ${duplicateProfiles.join(", ")}`);
  }
  // 运行席位可以有任意实例 ID，但 adapter 必须来自代码注册的模板。
  createTeamCatalog(profiles, { providerStore, onProviderDegraded });
  // 主席位和派生 fallback 共用同一个 adapter Map；实例化前冻结全局键空间，
  // 防止合法 profile id 被后写入的 fallback 静默覆盖。
  assertAdapterKeySpace(profiles);
  const factoryEntries = buildFactoryEntries({ eventStore, cwd, approvalResolver });

  const duplicateTemplates = duplicates(ADAPTER_TEMPLATES.map((template) => template.id));
  const duplicateFactories = duplicates(factoryEntries.map(([key]) => key));
  if (duplicateTemplates.length) throw manifestError(`duplicate adapter template ids: ${duplicateTemplates.join(", ")}`);
  if (duplicateFactories.length) throw manifestError(`duplicate adapter factory keys: ${duplicateFactories.join(", ")}`);

  const factories = new Map(factoryEntries);
  const declaredFactories = new Set(ADAPTER_TEMPLATES.map((template) => template.factoryKey));
  const unusedFactories = factoryEntries.map(([key]) => key).filter((key) => !declaredFactories.has(key));
  if (unusedFactories.length) throw manifestError(`adapter factories absent from manifest: ${unusedFactories.join(", ")}`);

  const adapters = new Map();
  for (const profile of profiles) {
    if (profile.enabled === false) continue;
    const { adapterTemplate } = resolveAdapterTemplate(profile);
    if (adapterTemplate.requiresCommand && !String(profile.command ?? "").trim()) continue;
    const factory = factories.get(adapterTemplate.factoryKey);
    if (!factory) throw manifestError(`adapter template references unknown factory ${adapterTemplate.factoryKey}`);
    const instance = factory(profile, adapterTemplate);
    if (instance?.id !== adapterTemplate.id) {
      throw manifestError(`${profile.id} factory ${adapterTemplate.factoryKey} created ${instance?.id || "an unidentified adapter"}, expected ${adapterTemplate.id}`);
    }
    adapters.set(profile.id, bindProvider(instance, profile, adapterTemplate, providerStore));

    if (adapterTemplate.fallbackFactoryKey) {
      const fallbackTemplate = ADAPTER_TEMPLATES.find((item) => item.id === adapterTemplate.fallbackAdapterId);
      const fallbackFactory = factories.get(adapterTemplate.fallbackFactoryKey);
      if (!fallbackTemplate || !fallbackFactory) throw manifestError(`${profile.id} fallback template is not executable`);
      const fallback = fallbackFactory(profile, fallbackTemplate);
      if (fallback?.id !== fallbackTemplate.id) {
        throw manifestError(`${profile.id} fallback factory created ${fallback?.id || "an unidentified adapter"}, expected ${fallbackTemplate.id}`);
      }
      adapters.set(`${profile.id}-fallback`, bindProvider(fallback, profile, fallbackTemplate, providerStore));
    }
  }
  return adapters;
}

/**
 * v41 波二：远程 run 专用 adapter（每 run 每席位一只，与本机席位池隔离）。
 * remote = { spawnImpl, runProcessImpl }（remote-run.mjs 的 SSH 桥）——同一张工厂表换实现。
 * 不挂 bindProvider：provider 投影切的是本机 env/登录态，远端 CLI 用各自配置文件（§3.4）。
 * grok-mcp 远程不适用：MCP server 是本机脚本路径，远端 spawn 必炸——模板层如实拒绝。
 * 返回 { adapter, fallback }：fallback 同样远程注入（远端 run 绝不回退到本机执行）。
 */
export function createRemoteAdapter({ profile, eventStore, cwd, approvalResolver, remote }) {
  const { adapterTemplate } = resolveAdapterTemplate(profile);
  if (adapterTemplate.factoryKey === "grok-mcp") {
    throw Object.assign(
      new Error(`${profile.id} adapter grok-mcp cannot run remotely: its MCP server is a local script path`),
      { code: "REMOTE_ADAPTER_UNSUPPORTED" },
    );
  }
  const factories = new Map(buildFactoryEntries({ eventStore, cwd, approvalResolver, remote }));
  const factory = factories.get(adapterTemplate.factoryKey);
  if (!factory) throw manifestError(`adapter template references unknown factory ${adapterTemplate.factoryKey}`);
  const adapter = factory(profile, adapterTemplate);
  if (adapter?.id !== adapterTemplate.id) {
    throw manifestError(`${profile.id} factory ${adapterTemplate.factoryKey} created ${adapter?.id || "an unidentified adapter"}, expected ${adapterTemplate.id}`);
  }
  let fallback = null;
  if (adapterTemplate.fallbackFactoryKey) {
    const fallbackTemplate = ADAPTER_TEMPLATES.find((item) => item.id === adapterTemplate.fallbackAdapterId);
    const fallbackFactory = factories.get(adapterTemplate.fallbackFactoryKey);
    if (!fallbackTemplate || !fallbackFactory) throw manifestError(`${profile.id} fallback template is not executable`);
    fallback = fallbackFactory(profile, fallbackTemplate);
    if (fallback?.id !== fallbackTemplate.id) {
      throw manifestError(`${profile.id} fallback factory created ${fallback?.id || "an unidentified adapter"}, expected ${fallbackTemplate.id}`);
    }
  }
  return { adapter, fallback };
}
