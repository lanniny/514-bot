import { assertUrlAllowedSync } from "./security/egress-guard.mjs";

export function apiChatError(code, message) {
  return Object.assign(new Error(message), { code, safeToFallback: false });
}

// Return only safe readiness metadata to catalogs. Credentials stay in ProviderStore.
export function apiChatConfiguration(profile, providerStore) {
  if (!profile.providerId) throw apiChatError("API_PROVIDER_REQUIRED", "文本聊天需要显式选择 Provider 连接");
  let provider;
  try { provider = providerStore?.get(profile.providerId); } catch {}
  if (!provider) throw apiChatError("API_PROVIDER_MISSING", "绑定的 Provider 不可用，请重新选择连接");
  if (!String(provider.apiKey || "").trim()) throw apiChatError("API_KEY_REQUIRED", "该连接尚未配置 API Key");
  if (String(provider.apiKey).length > 8192 || /[\x00-\x1f\x7f]/.test(provider.apiKey)) throw apiChatError("API_KEY_INVALID", "连接凭据格式无效，请检查 API Key");
  if (!String(profile.model || "").trim()) throw apiChatError("API_MODEL_REQUIRED", "请填写该连接允许的模型 ID");
  // This adapter selects its protocol explicitly; it does not inherit a CLI's defaults.
  const format = String(provider.meta?.apiFormat || "").toLowerCase();
  if (format && !["openai", "chat", "chat-completions", "openai-chat", "openai_chat", "openai-compatible", "openai_compatible", "chat_completions"].includes(format)) {
    throw apiChatError("API_PROTOCOL_UNSUPPORTED", "该连接声明的协议不是 Chat Completions，请选择兼容连接");
  }
  let url;
  try {
    url = new URL(provider.baseUrl);
    assertUrlAllowedSync(url.href, { policy: "lan" });
    const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !loopback)) throw new Error();
    const path = url.pathname.replace(/\/+$/, "");
    if (provider.meta?.isFullUrl) {
      if (!path.endsWith("/chat/completions")) throw new Error();
    } else {
      url.pathname = `${path || "/v1"}/chat/completions`;
    }
  } catch {
    throw apiChatError("API_ENDPOINT_INVALID", "连接地址需为 HTTPS API 基址或 Chat Completions 完整地址；本机回环地址可使用 HTTP");
  }
  return { provider, url };
}

export function apiChatReadiness(profile, providerStore) {
  try { apiChatConfiguration(profile, providerStore); return null; }
  catch (error) { return { reason: error.code, message: error.message }; }
}
