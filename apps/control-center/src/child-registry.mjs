// 子进程台账（2026-07-19 LO 报障：每次重启残留大量 codex/serena/nohup 孤儿进程）：
// spawnCommand 是服务端托管子进程的统一出口——每个子进程 {pid, image, startedAt} 落 dataRoot/children.json；
// 新实例拿到实例锁后 reapPrevious()：锁已保证旧主已死，台账里的全是孤儿，连树清理（含 MCP 孙子进程）。
// pid 复用防护（烛 v3.6 致命1：镜像名不是进程身份认证）双判据 fail-closed：
//   ① 镜像名必须与台账一致（空镜像=无法认证→跳过，绝不无条件杀）
//   ② 活进程创建时间必须早于台账登记时间（pid 被回收给新进程时创建时间必然晚于登记）
// 镜像明确不符或可比较的创建时间明确晚于登记 → 退役旧条目（不让已复用 pid 跨重启反复碰撞）；
// 探针暂时失败、必要身份字段缺失、终止命令失败或杀后仍存活则必须留账，供下一实例重试。
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

let registry = null;
const defaultStorage = { mkdir, readFile, writeFile };

export function configureChildRegistry(options) {
  registry = new ChildRegistry(options);
  return registry;
}

export function childRegistry() {
  return registry;
}

class ChildRegistry {
  constructor({ dataRoot, storage = defaultStorage }) {
    this.dataRoot = dataRoot;
    this.file = join(dataRoot, "children.json");
    this.storage = storage;
    this.entries = new Map(); // pid → { image, registeredAt }
    this.chain = Promise.resolve();
  }

  register(pid, image = "") {
    if (!pid) return;
    this.entries.set(pid, { image: String(image).toLowerCase(), registeredAt: new Date().toISOString() });
    void this.#persist();
  }

  unregister(pid) {
    if (!this.entries.delete(pid)) return;
    void this.#persist();
  }

  /**
   * Read-only, bounded process projection for the local control surface.
   * Command arguments and environment values are intentionally never retained,
   * so this cannot turn the child ledger into a credential disclosure surface.
   */
  snapshot({ limit = 32 } = {}) {
    const boundedLimit = Math.max(0, Math.min(Number(limit) || 0, 128));
    return [...this.entries.entries()]
      .slice(-boundedLimit)
      .map(([pid, meta]) => Object.freeze({
        pid,
        image: String(meta?.image || "process"),
        startedAt: String(meta?.registeredAt || ""),
      }));
  }

  #persist() {
    this.chain = this.chain
      .then(async () => {
        await this.storage.mkdir(this.dataRoot, { recursive: true });
        const payload = {
          ownerPid: process.pid,
          children: [...this.entries.entries()].map(([pid, meta]) => ({ pid, ...meta })),
          updatedAt: new Date().toISOString(),
        };
        await this.storage.writeFile(this.file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      })
      .catch(() => {}); // 台账是辅助资产，写失败不影响进程本身
    return this.chain;
  }

  /** 关闭时等待写链收敛（close() 调用；否则最后一次 unregister 的写盘可能被进程退出截断）。 */
  async flush() {
    await this.chain.catch(() => {});
  }

  /** 清理上一实例遗留的子进程树。调用前提：已持有实例锁（旧主必死），台账 pid 必是孤儿。 */
  async reapPrevious({ kill = defaultKillTree, probe = null } = {}) {
    let previous = null;
    try {
      previous = JSON.parse(await this.storage.readFile(this.file, "utf8"));
    } catch {
      return { reaped: 0, skipped: 0, failed: 0, pending: 0 }; // 无台账=干净启动
    }
    let reaped = 0;
    let skipped = 0;
    let failed = 0;
    const pending = new Map();
    // 旧格式台账兼容（2026-07-20 LO 爆内存报障根因之一）：v1 条目无 registeredAt，
    // 若按缺字段 fail-closed 全跳过，过渡期的孤儿一条都收不了、下次台账覆盖后彻底失忆成幽灵。
    // 回退判据 = 台账文件级 updatedAt（v1 也有）：登记必然早于台账最后落盘。
    const ledgerMs = Date.parse(previous?.updatedAt ?? "");
    const candidates = (Array.isArray(previous.children) ? previous.children : []).filter(
      (entry) => Number.isInteger(entry?.pid) && entry.pid > 0 && entry.pid !== process.pid,
    );
    // 批量身份查询（一次探针进程查全台账）：逐 pid 各起一个 PowerShell 会拖慢启动路径且叠内存
    const safeProbe = async (pid) => {
      try {
        return await (probe ? probe(pid) : queryProcessIdentity(pid));
      } catch {
        return undefined; // 探针异常不是“进程已死”
      }
    };
    const identities = probe
      ? new Map(await Promise.all(candidates.map(async (entry) => [entry.pid, await safeProbe(entry.pid)])))
      : await queryProcessIdentities(candidates.map((entry) => entry.pid));
    for (const entry of candidates) {
      const live = identities.get(entry.pid);
      if (live === null) continue; // 已确认死亡，无需再留账
      const registeredMs = Date.parse(entry.registeredAt ?? "");
      const referenceMs = Number.isFinite(registeredMs) ? registeredMs : ledgerMs;
      const meta = {
        image: String(entry.image ?? "").toLowerCase(),
        registeredAt: Number.isFinite(referenceMs) ? new Date(referenceMs).toISOString() : "",
      };
      if (!live) {
        skipped += 1;
        pending.set(entry.pid, meta); // 查询失败/未知，必须 fail-closed 留账
        continue;
      }
      // 双判据 fail-closed：镜像名一致 + 创建时间早于登记时间。
      // 数值比较（非 ISO 字符串字典序——PowerShell 7 位小数与 JS 3 位毫秒混排有边界陷阱），
      // 容忍 2s 时钟粒度差（StartTime 与登记时间来自不同时钟源）
      const liveImage = String(live.image ?? "").toLowerCase();
      const createdMs = Date.parse(live.createdAt ?? "");
      if (!meta.image || !liveImage || !Number.isFinite(referenceMs) || !Number.isFinite(createdMs)) {
        skipped += 1;
        pending.set(entry.pid, meta);
        continue;
      }
      if (liveImage !== meta.image || createdMs > referenceMs + 2_000) {
        skipped += 1;
        continue;
      }
      let killSucceeded = false;
      try {
        killSucceeded = (await kill(entry.pid)) === true;
      } catch {
        // 终止器抛错与非零退出等价，保留条目供下次重试。
      }
      if (!killSucceeded) {
        failed += 1;
        skipped += 1;
        pending.set(entry.pid, meta);
        continue;
      }
      const afterKill = await safeProbe(entry.pid);
      if (afterKill !== null) {
        failed += 1;
        skipped += 1;
        pending.set(entry.pid, meta);
        continue;
      }
      reaped += 1;
    }
    // 保留瞬态探针失败和终止失败目标；身份已不符的旧 pid 退役，避免未来复用误杀。
    const currentEntries = new Map(this.entries);
    this.entries.clear();
    for (const [pid, meta] of pending) this.entries.set(pid, meta);
    for (const [pid, meta] of currentEntries) this.entries.set(pid, meta);
    await this.#persist();
    return { reaped, skipped, failed, pending: pending.size };
  }
}

/** 批量活进程身份查询：Map<pid, { image, createdAt } | null | undefined>。
   null=确认不存在；undefined=探针失败、无法确定。
   Windows 单次 PowerShell Get-Process 查全部 pid（tasklist 拿不到创建时间）；
   探针失败/超时=全体不可认证（undefined → 调用侧 fail-closed 留账）。 */
export async function queryProcessIdentities(pids) {
  const identities = new Map(pids.map((pid) => [pid, undefined]));
  if (!pids.length) return identities;
  if (process.platform !== "win32") {
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        identities.set(pid, { image: "unknown", createdAt: null }); // 拿不到身份 → 双判据必失败 → 只跳过不杀
      } catch (error) {
        if (error?.code === "ESRCH") identities.set(pid, null);
        // EPERM 等错误无法证明进程不存在，保持 undefined。
      }
    }
    return identities;
  }
  const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(",");
  if (!list) return identities;
  // 每个请求 pid 都必须显式回报 exists=true/false；缺行或坏行保持 unknown，不能靠“没输出”推断死亡。
  const script = `@(${list}) | ForEach-Object { $requestedId = [int]$_; $item = Get-Process -Id $requestedId -ErrorAction SilentlyContinue; if ($null -eq $item) { @{ pid = $requestedId; exists = $false } | ConvertTo-Json -Compress } else { $createdAt = $null; $image = $null; try { $createdAt = $item.StartTime.ToUniversalTime().ToString('o') } catch {}; try { $image = ($item.ProcessName + '.exe') } catch {}; @{ pid = $requestedId; exists = $true; image = $image; createdAt = $createdAt } | ConvertTo-Json -Compress } }`;
  const result = await new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish({ ok: false, out: "" }); // 探针超时=不可认证 → fail-closed
    }, 15_000);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.once("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, out });
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish({ ok: false, out: "" });
    });
  });
  if (!result.ok) return identities;
  return parseProcessIdentityOutput(result.out, pids);
}

/** 解析 PowerShell 的逐 pid 明确回报。任何缺行、坏行、重复行或缺字段均保持 unknown。 */
export function parseProcessIdentityOutput(raw, pids) {
  const identities = new Map(pids.map((pid) => [pid, undefined]));
  const requested = new Set(pids);
  const seen = new Set();
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!Number.isInteger(parsed?.pid) || !requested.has(parsed.pid)) continue;
      if (seen.has(parsed.pid)) {
        identities.set(parsed.pid, undefined);
        continue;
      }
      seen.add(parsed.pid);
      if (parsed.exists === false) {
        identities.set(parsed.pid, null);
        continue;
      }
      if (parsed.exists !== true || typeof parsed.image !== "string" || !parsed.image.trim()) continue;
      identities.set(parsed.pid, {
        image: parsed.image.toLowerCase(),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
      });
    } catch {
      // 无法绑定到明确 pid 的坏行保持 unknown，绝不映射成“已死”。
    }
  }
  return identities;
}

/** 单 pid 身份查询（测试/工具用）。 */
export async function queryProcessIdentity(pid) {
  return (await queryProcessIdentities([pid])).get(pid);
}

export async function defaultKillTree(pid, { platform = process.platform, spawnImpl = spawn, timeoutMs = 5_000 } = {}) {
  if (platform === "win32") {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      let killer;
      try {
        killer = spawnImpl("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
      } catch {
        finish(false);
        return;
      }
      killer.once("close", (code) => finish(code === 0));
      killer.once("error", () => finish(false));
      timer = setTimeout(() => {
        finish(false);
        try { killer.kill(); } catch { /* The termination helper itself is owned. */ }
      }, Math.max(1, Math.min(30_000, Number(timeoutMs) || 5_000)));
    });
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
