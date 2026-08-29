/**
 * ssh.mjs — Wave G 远程主机核心（ssh2，凭据引用制 + known_hosts 指纹确认）。
 *
 * 契约（v40 设计 §3.2）：
 *   - 主机台账与 secrets 分文件；secrets 绝不进 API 响应
 *   - 首连返回指纹待确认；trust 后入库；指纹变更拒绝并告警
 *   - exec 超时强杀 + 输出封顶 + redaction；SFTP 路径白名单围栏
 *   - ssh2 Client 构造可注入（测试 fake Client 不连真网）
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { scrub } from "./redaction.mjs";
import { expandIdentityPath } from "./ssh/discover.mjs";

const require = createRequire(import.meta.url);
const { Client: Ssh2Client } = require("ssh2");

const EXEC_OUTPUT_CAP = 256 * 1024;
const SFTP_READ_CAP = 1024 * 1024;
const POOL_IDLE_MS = 5 * 60_000;

function sshError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus });
}

/**
 * 台账 host/user 的 argv 安全形：拼进 `${user}@${host}` 单个 argv 后不能以 "-" 开头
 * （否则 OpenSSH 把整个 token 当选项解析，如 -oProxyCommand=…），也不允许空白/控制字符。
 */
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST_PATTERN = /^[A-Za-z0-9._:\[%][A-Za-z0-9._:%\[\]-]{0,252}$/;

export function assertSshIdentityShape(host, user) {
  if (!SSH_USER_PATTERN.test(String(user))) {
    throw sshError("SSH_BAD_USER", `ssh user failed safe argv shape: ${JSON.stringify(String(user).slice(0, 40))}`);
  }
  if (!SSH_HOST_PATTERN.test(String(host))) {
    throw sshError("SSH_BAD_HOST", `ssh host failed safe argv shape: ${JSON.stringify(String(host).slice(0, 80))}`);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return fallback;
  }
}

export function createSshService({
  dataRoot,
  eventStore = null,
  clientFactory = null, // (connectConfig, hostKeyHashCallback) => Client-like；测试注入 fake
  homeResolver = null, // (host) => string 远程家目录（默认 /home/<user> 或 C:/Users/<user>）
  identityProvider = null, // async (entry) => string|null 无 secret 时的私钥内容；默认走 IdentityFile/默认密钥文件
} = {}) {
  const root = String(dataRoot);
  const hostsPath = join(root, "ssh-hosts.json");
  const secretsPath = join(root, "ssh-secrets.json");
  const knownHostsPath = join(root, "ssh-known-hosts.json");
  const state = {
    hosts: new Map(),
    secrets: new Map(),
    knownHosts: new Map(), // hostId → fingerprint
    pool: new Map(), // hostId → { client, lastUsedAt }
    writeChains: new Map(),
  };
  const makeClient = clientFactory ?? ((config, onHostKey) => {
    const client = new Ssh2Client();
    if (onHostKey) client.config = { ...client.config, hostVerifier: onHostKey };
    return client;
  });

  function audit(type, detail) {
    void eventStore?.emit?.(type, detail, { sensitivity: "internal", agentId: "control-plane" })?.catch?.(() => {});
  }

  function persist(path, payload) {
    const chain = (state.writeChains.get(path) ?? Promise.resolve()).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmp, path);
    });
    state.writeChains.set(path, chain.catch(() => {}));
    return chain;
  }

  async function init() {
    const hosts = await readJson(hostsPath, { hosts: [] });
    const secrets = await readJson(secretsPath, { secrets: [] });
    const known = await readJson(knownHostsPath, { knownHosts: [] });
    for (const host of hosts.hosts ?? []) if (host?.id) state.hosts.set(host.id, host);
    for (const secret of secrets.secrets ?? []) if (secret?.id) state.secrets.set(secret.id, secret);
    for (const entry of known.knownHosts ?? []) if (entry?.hostId) state.knownHosts.set(entry.hostId, entry.fingerprint);
    return service;
  }

  function publicHost(host) {
    if (!host) return null;
    const { authRef, ...rest } = host;
    return {
      ...rest,
      authRef: authRef ? "***" : null,
      hasSecret: Boolean(authRef && state.secrets.has(authRef)),
      trusted: state.knownHosts.has(host.id),
      fingerprint: state.knownHosts.get(host.id) ?? null,
    };
  }

  function list() {
    return [...state.hosts.values()].map(publicHost);
  }

  async function create({ name, host, port = 22, user, auth = {}, rootAllowlist = [], enabled = true, identityFile = null } = {}) {
    if (!host || !user) throw sshError("SSH_BAD_HOST", "host and user are required");
    assertSshIdentityShape(host, user);
    const id = randomUUID().slice(0, 8);
    let authRef = null;
    if (auth.password || auth.privateKey) {
      authRef = randomUUID().slice(0, 8);
      state.secrets.set(authRef, {
        id: authRef,
        password: auth.password ? String(auth.password) : null,
        privateKey: auth.privateKey ? String(auth.privateKey) : null,
        passphrase: auth.passphrase ? String(auth.passphrase) : null,
      });
      await persist(secretsPath, { schema: "514cc.ssh-secrets/v1", secrets: [...state.secrets.values()] });
    }
    const entry = {
      id,
      name: String(name || host),
      host: String(host),
      port: Number(port) || 22,
      user: String(user),
      authRef,
      rootAllowlist: Array.isArray(rootAllowlist) ? rootAllowlist.map(String) : [],
      enabled: enabled !== false,
      identityFile: identityFile ? String(identityFile) : null,
      createdAt: new Date().toISOString(),
    };
    state.hosts.set(id, entry);
    await persist(hostsPath, { schema: "514cc.ssh-hosts/v1", hosts: [...state.hosts.values()] });
    audit("ssh.host_create", { hostId: id, host: entry.host });
    return publicHost(entry);
  }

  async function remove(id) {
    const entry = state.hosts.get(String(id));
    if (!entry) return false;
    state.hosts.delete(entry.id);
    if (entry.authRef) {
      state.secrets.delete(entry.authRef);
      await persist(secretsPath, { schema: "514cc.ssh-secrets/v1", secrets: [...state.secrets.values()] });
    }
    state.knownHosts.delete(id);
    await persist(knownHostsPath, { schema: "514cc.ssh-known-hosts/v1", knownHosts: [...state.knownHosts].map(([hostId, fingerprint]) => ({ hostId, fingerprint })) });
    await persist(hostsPath, { schema: "514cc.ssh-hosts/v1", hosts: [...state.hosts.values()] });
    dropPooled(id);
    audit("ssh.host_delete", { hostId: id });
    return true;
  }

  function getRequired(id) {
    const entry = state.hosts.get(String(id));
    if (!entry) throw sshError("SSH_NOT_FOUND", `host not found: ${id}`, 404);
    return entry;
  }

  /** 指纹策略：已信任→比对；未信任→抛 SSH_HOSTKEY_UNCONFIRMED 带指纹；变更→SSH_HOSTKEY_CHANGED。 */
  function checkHostKey(hostId, fingerprint) {
    const known = state.knownHosts.get(hostId);
    if (!known) {
      throw sshError("SSH_HOSTKEY_UNCONFIRMED", `host key pending confirmation: ${fingerprint}`, 409);
    }
    if (known !== fingerprint) {
      audit("ssh.hostkey_changed", { hostId });
      throw sshError("SSH_HOSTKEY_CHANGED", "host key fingerprint changed; re-trust required", 409);
    }
  }

  async function trust(id, fingerprint) {
    const entry = getRequired(id);
    const value = String(fingerprint || "").trim();
    if (!value) throw sshError("SSH_BAD_FINGERPRINT", "fingerprint is required");
    state.knownHosts.set(entry.id, value);
    await persist(knownHostsPath, {
      schema: "514cc.ssh-known-hosts/v1",
      knownHosts: [...state.knownHosts].map(([hostId, fp]) => ({ hostId, fingerprint: fp })),
    });
    audit("ssh.trust", { hostId: entry.id });
    return publicHost(entry);
  }

  /** 启用/停用开关（Codex「连接」行 toggle）：停用即拒连并丢弃池化连接；旧台账无字段视为启用。 */
  async function setEnabled(id, enabled) {
    const entry = getRequired(id);
    entry.enabled = enabled !== false;
    if (!entry.enabled) dropPooled(id);
    await persist(hostsPath, { schema: "514cc.ssh-hosts/v1", hosts: [...state.hosts.values()] });
    audit("ssh.host_enabled", { hostId: entry.id, enabled: entry.enabled });
    return publicHost(entry);
  }

  /**
   * 通用字段更新（同步 ssh config 用）：仅白名单字段；
   * host/port 变更 → 旧指纹失效（删 known_hosts 记录强制重新 TOFU）+ 丢池；
   * 其余认证材料变更（user/identityFile/name）→ 仅丢池（池化连接用的是旧参数）。
   */
  async function update(id, fields = {}) {
    const entry = getRequired(id);
    const next = {};
    if (fields.name != null && String(fields.name).trim()) next.name = String(fields.name).trim();
    if (fields.host != null && String(fields.host).trim()) next.host = String(fields.host).trim();
    if (fields.port != null && Number(fields.port) > 0 && Number(fields.port) < 65536) next.port = Number(fields.port);
    if (fields.user != null && String(fields.user).trim()) next.user = String(fields.user).trim();
    if (fields.identityFile !== undefined) next.identityFile = fields.identityFile ? String(fields.identityFile) : null;
    // 远程探测实测回写的远端 $HOME（POSIX 或 Windows 盘符形态）：SFTP 围栏根的准确来源
    if (typeof fields.home === "string" && (/^\//.test(fields.home) || /^[A-Za-z]:[\\/]/.test(fields.home))) next.home = fields.home;
    const endpointChanged = (next.host && next.host !== entry.host) || (next.port && next.port !== entry.port);
    if (next.host || next.user) assertSshIdentityShape(next.host ?? entry.host, next.user ?? entry.user);
    Object.assign(entry, next);
    dropPooled(id);
    if (endpointChanged) {
      state.knownHosts.delete(id);
      await persist(knownHostsPath, { schema: "514cc.ssh-known-hosts/v1", knownHosts: [...state.knownHosts].map(([hostId, fingerprint]) => ({ hostId, fingerprint })) });
    }
    await persist(hostsPath, { schema: "514cc.ssh-hosts/v1", hosts: [...state.hosts.values()] });
    audit("ssh.host_update", { hostId: id, fields: Object.keys(next), endpointChanged });
    return publicHost(entry);
  }

  function dropPooled(id) {
    const pooled = state.pool.get(id);
    if (pooled) {
      try {
        pooled.client.end();
      } catch { /* 已断 */ }
      state.pool.delete(id);
    }
  }

  /** ssh-agent 位置：Unix 取 SSH_AUTH_SOCK；Windows 取 OpenSSH 服务命名管道。agent 不可用时 ssh2 会静默跳过该认证方式。 */
  function defaultAgentPath() {
    if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
    if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";
    return null;
  }

  /** 默认私钥来源（仅无 secret 时）：台账 identityFile 路径优先，其次 ~/.ssh/id_ed25519/id_rsa/id_ecdsa；只读入内存不落盘。 */
  async function defaultIdentityProvider(entry) {
    const candidates = [];
    const fromConfig = expandIdentityPath(entry.identityFile, entry);
    if (fromConfig) candidates.push(fromConfig);
    for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) candidates.push(join(homedir(), ".ssh", name));
    for (const candidate of candidates) {
      try {
        const content = await readFile(candidate, "utf8");
        if (content.includes("ENCRYPTED")) continue; // 无 passphrase 的加密 PEM 跳过；openssh 加密格式交由 ssh2 报清晰错误
        return content;
      } catch { /* 不存在，换下一个候选 */ }
    }
    return null;
  }

  async function buildConnectConfig(entry) {
    const secret = entry.authRef ? state.secrets.get(entry.authRef) : null;
    const config = { host: entry.host, port: entry.port, username: entry.user, readyTimeout: 10_000 };
    if (secret?.password) config.password = secret.password;
    if (secret?.privateKey) {
      config.privateKey = secret.privateKey;
      if (secret.passphrase) config.passphrase = secret.passphrase;
    }
    if (!secret) {
      // 密钥认证链：IdentityFile/默认密钥 + ssh-agent（对齐系统 ssh「已配置正常」的语义）
      const identity = await (identityProvider ?? defaultIdentityProvider)(entry);
      if (identity) config.privateKey = identity;
      const agent = defaultAgentPath();
      if (agent) config.agent = agent;
    }
    return config;
  }

  /** 取连接：池化复用；hostVerifier 钩子交给 makeClient（fake 注入时由 fake 触发 onHostKey）。 */
  async function connect(hostId, { hostKeyFingerprint = null } = {}) {
    const entry = getRequired(hostId);
    if (entry.enabled === false) throw sshError("SSH_HOST_DISABLED", `host is disabled: ${entry.host}`, 409);
    // 指纹三态判定先于连接（fake 模式下由调用方传 fingerprint；真实 ssh2 经 hostVerifier 回调）
    const pending = { fingerprint: hostKeyFingerprint };
    if (pending.fingerprint) checkHostKey(hostId, pending.fingerprint);
    else if (!state.knownHosts.has(hostId)) {
      throw sshError("SSH_HOSTKEY_UNCONFIRMED", `host ${entry.host} has no trusted fingerprint; connect once with fingerprint capture or POST trust`, 409);
    }
    const pooled = state.pool.get(hostId);
    if (pooled && Date.now() - pooled.lastUsedAt < POOL_IDLE_MS) {
      pooled.lastUsedAt = Date.now();
      audit("ssh.connect_reused", { hostId });
      return { entry, client: pooled.client, reused: true };
    }
    dropPooled(hostId);
    const baseConfig = await buildConnectConfig(entry);
    const client = makeClient(baseConfig, (hashedKey) => {
      const fingerprint = String(hashedKey || "");
      if (fingerprint) checkHostKey(hostId, fingerprint);
      return true;
    });
    await new Promise((resolveConnect, rejectConnect) => {
      const timer = setTimeout(() => rejectConnect(sshError("SSH_TIMEOUT", "connect timeout", 504)), 12_000);
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      client.once("ready", () => settle(resolveConnect));
      // 进程级铁律（LO「闪退」根因）：ssh2 认证回退链会多次 emit('error')，
      // EventEmitter 对无监听器的 'error' 直接 throw 杀进程——监听器必须终生在籍。
      client.on("error", (error) => {
        if (!settled) {
          settle(rejectConnect, sshError("SSH_CONNECT_FAILED", error.message, 502));
          return;
        }
        audit("ssh.pool_error", { hostId, message: error.message });
        dropPooled(hostId); // 运行期错误：丢池即可，绝不让进程死
      });
      client.once("close", () => dropPooled(hostId)); // 对端关闭即失活，不池化尸体
      // 真实 ssh2 的指纹三态在 connect 配置里生效（hostVerifier 回调）；fake 走工厂第二参回调，两者并存
      client.connect({
        ...baseConfig,
        hostHash: "sha256",
        hostVerifier: (hashedKey) => {
          try {
            checkHostKey(hostId, `SHA256:${String(hashedKey || "").replace(/=+$/, "")}`);
            return true;
          } catch {
            return false; // 未信任/指纹变更 → ssh2 以连接失败收尾，预检已先行拦截
          }
        },
      });
    });
    state.pool.set(hostId, { client, lastUsedAt: Date.now() });
    audit("ssh.connect", { hostId, host: entry.host });
    return { entry, client, reused: false };
  }

  async function exec(id, { command, timeoutMs = 30_000, hostKeyFingerprint = null } = {}) {
    if (!String(command || "").trim()) throw sshError("SSH_BAD_COMMAND", "command is required");
    const { client } = await connect(id, { hostKeyFingerprint });
    const cappedTimeout = Math.min(120_000, Math.max(1_000, Number(timeoutMs) || 30_000));
    const result = await new Promise((resolveExec, rejectExec) => {
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let channel = null;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        const timeoutError = sshError("SSH_EXEC_TIMEOUT", `exec timed out after ${cappedTimeout}ms`, 504);
        settle(rejectExec, timeoutError);
        try {
          channel?.close?.();
          channel?.destroy?.();
        } catch { /* channel 已关闭 */ }
        dropPooled(id);
      }, cappedTimeout);
      client.exec(String(command), (error, stream) => {
        if (error) {
          settle(rejectExec, sshError("SSH_EXEC_FAILED", error.message, 502));
          return;
        }
        channel = stream;
        if (settled) {
          try {
            stream.close?.();
            stream.destroy?.();
          } catch { /* timeout 已负责丢弃连接 */ }
          return;
        }
        stream.on("data", (chunk) => {
          if (stdout.length < EXEC_OUTPUT_CAP) stdout += chunk.toString("utf8");
          else stdoutTruncated = true;
        });
        stream.stderr.on("data", (chunk) => {
          if (stderr.length < EXEC_OUTPUT_CAP) stderr += chunk.toString("utf8");
          else stderrTruncated = true;
        });
        stream.on("close", (code) => {
          settle(resolveExec, {
            code,
            stdout: scrub(stdout.slice(0, EXEC_OUTPUT_CAP)),
            stderr: scrub(stderr.slice(0, EXEC_OUTPUT_CAP)),
            stdoutTruncated,
            stderrTruncated,
          });
        });
      });
    });
    audit("ssh.exec", { hostId: id, code: result.code });
    return result;
  }

  /**
   * run 通道（v41 波二）：全双工 streaming exec channel——无输出 cap、无 scrub、无硬超时。
   * 协议字节（行 JSON/JSON-RPC）原样过；idle/turn 看门狗归 adapter 既有闸，不归这里。
   * 取消语义由调用方负责（remote-run.mjs 的 pgid kill）；通道 close 仅作兜底。
   */
  async function openRunChannel(id, commandLine, { hostKeyFingerprint = null } = {}) {
    if (!String(commandLine || "").trim()) throw sshError("SSH_BAD_COMMAND", "command is required");
    const { client } = await connect(id, { hostKeyFingerprint });
    const stream = await new Promise((resolveExec, rejectExec) => {
      client.exec(String(commandLine), (error, channel) => {
        if (error) rejectExec(sshError("SSH_EXEC_FAILED", error.message, 502));
        else resolveExec(channel);
      });
    });
    audit("ssh.run_channel_open", { hostId: id });
    stream.on("close", () => audit("ssh.run_channel_close", { hostId: id }));
    return stream;
  }

  function sftpRoots(entry) {
    const home = homeResolver?.(entry) ?? entry.home ?? (entry.host.includes("win") ? `C:/Users/${entry.user}` : `/home/${entry.user}`);
    return entry.rootAllowlist.length ? entry.rootAllowlist : [home, "/tmp"];
  }

  function normalizeSftpPath(value) {
    return String(value).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  }

  function sftpPathWithin(candidate, root) {
    let normalizedCandidate = normalizeSftpPath(candidate);
    let normalizedRoot = normalizeSftpPath(root);
    if (/^[A-Za-z]:\//.test(normalizedCandidate) || /^[A-Za-z]:\//.test(normalizedRoot)) {
      normalizedCandidate = normalizedCandidate.toLowerCase();
      normalizedRoot = normalizedRoot.toLowerCase();
    }
    return normalizedRoot === "/" || normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
  }

  function assertSftpPath(entry, candidate) {
    const path = String(candidate || "").trim();
    if (!path || path.includes("\0")) throw sshError("SFTP_BAD_PATH", "path is required", 403);
    const normalized = path.replace(/\\/g, "/");
    const ok = sftpRoots(entry).some((rootPath) => sftpPathWithin(normalized, rootPath));
    if (!ok || normalized.includes("..")) {
      throw sshError("SFTP_PATH_BOUNDARY", `path escapes allowlist: ${path}`, 403);
    }
    return path;
  }

  function sftpRealpath(sftp, path) {
    return new Promise((resolvePath, rejectPath) => {
      sftp.realpath(path, (error, resolved) => {
        if (error) rejectPath(error);
        else resolvePath(normalizeSftpPath(resolved));
      });
    });
  }

  async function assertSftpResolvedPath(entry, candidate, sftp, { allowMissing = false } = {}) {
    const lexical = normalizeSftpPath(assertSftpPath(entry, candidate));
    const canonicalRoots = [];
    for (const root of sftpRoots(entry)) {
      try {
        canonicalRoots.push(await sftpRealpath(sftp, normalizeSftpPath(root)));
      } catch {
        // An unavailable allowlist root grants no access; another configured root may still match.
      }
    }
    if (!canonicalRoots.length) throw sshError("SFTP_PATH_BOUNDARY", "cannot resolve any SFTP allowlist root", 403);
    let canonical;
    try {
      canonical = await sftpRealpath(sftp, lexical);
    } catch (error) {
      if (!allowMissing) throw sshError("SFTP_FAILED", error.message, 502);
      const parent = posix.dirname(lexical);
      const canonicalParent = await sftpRealpath(sftp, parent).catch((cause) => {
        throw sshError("SFTP_PATH_BOUNDARY", `cannot resolve SFTP parent: ${cause.message}`, 403);
      });
      canonical = normalizeSftpPath(posix.join(canonicalParent, posix.basename(lexical)));
    }
    if (!canonicalRoots.some((root) => sftpPathWithin(canonical, root))) {
      throw sshError("SFTP_PATH_BOUNDARY", `resolved path escapes allowlist: ${lexical}`, 403);
    }
    return canonical;
  }

  async function withSftp(id, hostKeyFingerprint, fn) {
    const entry = getRequired(id);
    const { client } = await connect(id, { hostKeyFingerprint });
    const sftp = await new Promise((resolveSftp, rejectSftp) => {
      client.sftp((error, session) => (error ? rejectSftp(sshError("SFTP_FAILED", error.message, 502)) : resolveSftp(session)));
    });
    return { entry, result: await fn(sftp) };
  }

  async function assertSftpResolvedPathPublic(id, path, { hostKeyFingerprint = null, allowMissing = false } = {}) {
    const entry = getRequired(id);
    const lexical = assertSftpPath(entry, path);
    const { result } = await withSftp(id, hostKeyFingerprint, async (sftp) => {
      return assertSftpResolvedPath(entry, lexical, sftp, { allowMissing });
    });
    return result;
  }

  async function sftpList(id, path, { hostKeyFingerprint = null } = {}) {
    const entry = getRequired(id);
    assertSftpPath(entry, path); // 围栏先于任何远端操作
    const { result } = await withSftp(id, hostKeyFingerprint, async (sftp) => {
      await assertSftpResolvedPath(entry, path, sftp);
      return new Promise((resolveList, rejectList) => {
        sftp.readdir(path, (error, listing) => (error ? rejectList(sshError("SFTP_FAILED", error.message, 502)) : resolveList(listing)));
      });
    });
    audit("ssh.sftp_list", { hostId: id });
    return (result ?? []).map((item) => ({
      name: item.filename,
      size: item.attrs?.size ?? 0,
      isDirectory: Boolean(item.attrs?.isDirectory?.()),
      mtime: item.attrs?.mtime ?? null,
    }));
  }

  async function sftpRead(id, path, { hostKeyFingerprint = null } = {}) {
    const entry = getRequired(id);
    assertSftpPath(entry, path);
    const { result } = await withSftp(id, hostKeyFingerprint, async (sftp) => {
      await assertSftpResolvedPath(entry, path, sftp, { allowMissing: true });
      return new Promise((resolveRead, rejectRead) => {
        const chunks = [];
        let size = 0;
        const stream = sftp.createReadStream(path);
        stream.on("data", (chunk) => {
          if (size < SFTP_READ_CAP) {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        stream.on("error", (error) => rejectRead(sshError("SFTP_FAILED", error.message, 502)));
        stream.on("end", () => resolveRead({ content: scrub(Buffer.concat(chunks).toString("utf8")), truncated: size >= SFTP_READ_CAP }));
      });
    });
    audit("ssh.sftp_read", { hostId: id });
    return result;
  }

  /**
   * 服务端内部配置事务读取。与 sftpRead 使用同一围栏和 1MB cap，但不 scrub，
   * 因为投影器必须在不覆盖远端既有 token/key 的前提下做结构化合并。
   * 本方法不接 HTTP 路由，原文只能进入服务端事务，禁止直接返回浏览器。
   */
  async function sftpReadRaw(id, path, { hostKeyFingerprint = null } = {}) {
    const entry = getRequired(id);
    assertSftpPath(entry, path);
    const { result } = await withSftp(id, hostKeyFingerprint, async (sftp) => {
      await assertSftpResolvedPath(entry, path, sftp, { allowMissing: true });
      return new Promise((resolveRead, rejectRead) => {
        const chunks = [];
        let size = 0;
        const stream = sftp.createReadStream(path);
        stream.on("data", (chunk) => {
          if (size < SFTP_READ_CAP) chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("error", (error) => rejectRead(sshError("SFTP_FAILED", error.message, 502)));
        stream.on("end", () => {
          if (size > SFTP_READ_CAP) {
            rejectRead(sshError("SFTP_TOO_LARGE", "content exceeds 1MB cap", 413));
            return;
          }
          resolveRead({ content: Buffer.concat(chunks).toString("utf8"), truncated: false });
        });
      });
    });
    audit("ssh.sftp_read_raw", { hostId: id, bytes: Buffer.byteLength(result.content) });
    return result;
  }

  async function sftpWrite(id, path, content, {
    hostKeyFingerprint = null,
    mode = 0o600,
    flags = "w",
  } = {}) {
    const entry = getRequired(id);
    assertSftpPath(entry, path);
    const text = String(content ?? "");
    if (Buffer.byteLength(text) > SFTP_READ_CAP) throw sshError("SFTP_TOO_LARGE", "content exceeds 1MB cap", 413);
    const writeMode = Number.isInteger(mode) && mode >= 0 && mode <= 0o777 ? mode : 0o600;
    const writeFlags = flags === "wx" ? "wx" : "w";
    await withSftp(id, hostKeyFingerprint, async (sftp) => {
      await assertSftpResolvedPath(entry, path, sftp, { allowMissing: true });
      return new Promise((resolveWrite, rejectWrite) => {
        const stream = sftp.createWriteStream(path, { flags: writeFlags, mode: writeMode });
        stream.on("error", (error) => rejectWrite(sshError("SFTP_FAILED", error.message, 502)));
        stream.on("close", resolveWrite);
        stream.end(text);
      });
    });
    audit("ssh.sftp_write", { hostId: id, bytes: Buffer.byteLength(text) });
    return { ok: true, bytes: Buffer.byteLength(text) };
  }

  function sftpPathPrefixes(normalized) {
    if (/^[A-Za-z]:\//.test(normalized)) {
      let current = `${normalized.slice(0, 2)}/`;
      const prefixes = [current.replace(/\/+$/, "/")];
      for (const part of normalized.slice(3).split("/").filter(Boolean)) {
        current = `${current.replace(/\/+$/, "")}/${part}`;
        prefixes.push(current);
      }
      return prefixes;
    }
    const prefixes = [];
    let current = "";
    for (const part of normalized.split("/").filter(Boolean)) {
      current += `/${part}`;
      prefixes.push(current);
    }
    return prefixes;
  }

  function sftpMkdirOne(sftp, path) {
    return new Promise((resolveMkdir, rejectMkdir) => {
      sftp.mkdir(path, (error) => {
        if (!error) return resolveMkdir();
        const already = error.code === 11 || /exists|EEXIST|already/i.test(String(error.message || ""));
        if (already) return resolveMkdir();
        if (typeof sftp.stat !== "function") {
          rejectMkdir(sshError("SFTP_FAILED", error.message, 502));
          return;
        }
        sftp.stat(path, (statError, attrs) => {
          if (!statError && attrs?.isDirectory?.()) return resolveMkdir();
          rejectMkdir(sshError("SFTP_FAILED", error.message, 502));
        });
      });
    });
  }

  async function sftpEnsureDir(id, path, { hostKeyFingerprint = null } = {}) {
    const entry = getRequired(id);
    const lexical = normalizeSftpPath(assertSftpPath(entry, path));
    await withSftp(id, hostKeyFingerprint, async (sftp) => {
      const canonicalRoots = [];
      for (const root of sftpRoots(entry)) {
        try {
          canonicalRoots.push(await sftpRealpath(sftp, normalizeSftpPath(root)));
        } catch {
          // An unavailable allowlist root grants no access; another configured root may still match.
        }
      }
      if (!canonicalRoots.length) throw sshError("SFTP_PATH_BOUNDARY", "cannot resolve any SFTP allowlist root", 403);

      let lastCanonical = null;
      const missing = [];
      for (const prefix of sftpPathPrefixes(lexical)) {
        if (!sftpRoots(entry).some((root) => sftpPathWithin(prefix, root))) continue;
        try {
          const resolved = await sftpRealpath(sftp, prefix);
          if (!canonicalRoots.some((root) => sftpPathWithin(resolved, root))) {
            throw sshError("SFTP_PATH_BOUNDARY", `resolved path escapes allowlist: ${prefix}`, 403);
          }
          lastCanonical = resolved;
        } catch (error) {
          if (error?.code === "SFTP_PATH_BOUNDARY") throw error;
          missing.push(prefix.split("/").filter(Boolean).pop());
        }
      }
      if (!lastCanonical) throw sshError("SFTP_PATH_BOUNDARY", `cannot resolve SFTP parent for ${lexical}`, 403);
      let current = lastCanonical;
      for (const name of missing) {
        current = `${current.replace(/\/+$/, "")}/${name}`;
        if (!canonicalRoots.some((root) => sftpPathWithin(current, root))) {
          throw sshError("SFTP_PATH_BOUNDARY", `mkdir path escapes allowlist: ${current}`, 403);
        }
        await sftpMkdirOne(sftp, current);
      }
    });
    audit("ssh.sftp_mkdir", { hostId: id });
    return { ok: true, path: lexical };
  }

  async function testConnection(id, { hostKeyFingerprint = null } = {}) {
    const { reused } = await connect(id, { hostKeyFingerprint });
    return { ok: true, reused };
  }

  /**
   * TOFU 捕获：真实连一次只取主机指纹，立刻断开、不入池、不做信任判定。
   * 信任决策永远在 trust()；这里返回的指纹交给人工核对后回传。
   */
  async function captureFingerprint(id) {
    const entry = getRequired(id);
    if (entry.enabled === false) throw sshError("SSH_HOST_DISABLED", `host is disabled: ${entry.host}`, 409);
    let fingerprint = null;
    const record = (hashedKey) => {
      const value = String(hashedKey || "");
      if (value) fingerprint = value.startsWith("SHA256:") ? value : `SHA256:${value.replace(/=+$/, "")}`;
      return true; // 捕获路径一律接受；信任与否是 trust() 的事
    };
    const baseConfig = await buildConnectConfig(entry);
    const client = makeClient(baseConfig, record);
    await new Promise((resolveCapture, rejectCapture) => {
      const timer = setTimeout(() => rejectCapture(sshError("SSH_TIMEOUT", "connect timeout", 504)), 12_000);
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      client.once("ready", () => settle(resolveCapture));
      // 持久 error 监听（同 connect 铁律）：认证回退链多次 emit('error')，
      // 主机键先于认证交换——任何一次错误到来时已捕获指纹即成功
      client.on("error", (error) => {
        if (fingerprint) return settle(resolveCapture);
        settle(rejectCapture, sshError("SSH_CONNECT_FAILED", error.message, 502));
      });
      client.connect({ ...baseConfig, hostHash: "sha256", hostVerifier: record });
    });
    try {
      client.end();
    } catch { /* 已断 */ }
    if (!fingerprint) throw sshError("SSH_CONNECT_FAILED", "host did not present a host key", 502);
    audit("ssh.fingerprint_capture", { hostId: id });
    return { fingerprint };
  }

  async function close() {
    for (const id of [...state.pool.keys()]) dropPooled(id);
    await Promise.all([...state.writeChains.values()]);
  }

  const service = {
    init, list, create, remove, trust, exec, testConnection, setEnabled, captureFingerprint, update, close, openRunChannel,
    sftpList, sftpRead, sftpReadRaw, sftpWrite, sftpEnsureDir, checkHostKey,
    assertSftpPathPublic: (id, path) => assertSftpPath(getRequired(id), path),
    assertSftpResolvedPathPublic,
    _state: state,
  };
  return service;
}
