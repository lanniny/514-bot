/**
 * Adapter-aware native slash contract.
 * Unknown commands fail closed; Codex /compact is an adapter hook, not a prompt.
 */
const LINE_RE = /^\/[A-Za-z0-9_-]+(?:[ \t]+\S+){0,8}$/;

export function parseNativeCommandLine(prompt) {
  const raw = String(prompt ?? "").trim();
  if (!LINE_RE.test(raw)) return null;
  const [token, ...rest] = raw.split(/[ \t]+/);
  return { token: token.toLowerCase(), args: rest, raw };
}

export function nativeCommandsOf(template) {
  return Array.isArray(template?.nativeCommands) ? [...template.nativeCommands] : [];
}

export function resolveNativeCommand(template, prompt) {
  const adapterLabel = String(template?.label || template?.id || "当前成员");
  const parsed = parseNativeCommandLine(prompt);
  if (!parsed) {
    return {
      ok: false,
      code: "NATIVE_COMMAND_INVALID",
      message: "nativeCommand prompt must be a single-line slash command like /compact",
    };
  }
  const hit = nativeCommandsOf(template).find((item) => String(item.token).toLowerCase() === parsed.token);
  if (!hit) {
    return {
      ok: false,
      code: "NATIVE_COMMAND_UNSUPPORTED",
      token: parsed.token,
      message: `${adapterLabel} 不支持 ${parsed.token}。完整 TUI 请用 /cli 附着该成员的原生会话。`,
    };
  }
  if (hit.execution === "cli-attach") {
    return {
      ok: false,
      code: "NATIVE_COMMAND_ATTACH_REQUIRED",
      token: parsed.token,
      command: hit,
      message: hit.detail || `${adapterLabel} 的 ${parsed.token} 只能在原生 TUI 中执行。请用 /cli 附着。`,
    };
  }
  if (hit.execution === "adapter-hook") {
    if (hit.hook !== "compactThread") {
      return {
        ok: false,
        code: "NATIVE_COMMAND_UNSUPPORTED",
        token: parsed.token,
        command: hit,
        message: `${adapterLabel} 的 ${parsed.token} 钩子未实现。`,
      };
    }
    if (parsed.args.length) {
      return {
        ok: false,
        code: "NATIVE_COMMAND_INVALID",
        token: parsed.token,
        command: hit,
        message: `${parsed.token} 不接受额外参数。`,
      };
    }
  }
  return { ok: true, parsed, command: hit };
}
