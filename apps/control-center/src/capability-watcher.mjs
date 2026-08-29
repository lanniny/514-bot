// capability-watcher：CLI 配置文件的外部变更感知（T4 capability.changed 实时同步）。
//
// 协作台读取各 CLI 配置文件（~/.grok/config.toml 等）但从不监听变化：grok TUI /config、
// cc-switch 或手改之后，界面只在手动刷新时才跟上。这里做文件事件驱动的秒级同步：
//   - fs.watch「父目录 + 目标文件」双通道。Windows 原子写会 rename 替换目标文件，
//     文件句柄随之失效，父目录通道负责在替换后继续看见新文件；
//   - 300-500ms 防抖合并编辑器/原子写的连环事件；
//   - 读文件算 sha256 与上次比对——内容不变不产生事件（保存≠变更）；
//   - 文件不存在/不可读视为「缺失」状态，同样参与哈希比对（缺失↔存在就是能力变化）；
//   - watch 创建失败/出错 → 该目标转 30s 间隔惰性哈希轮询，回调标 degraded: true。
//
// 安全纪律：配置文件含明文 api_key。keySummary 只抽键名（值只参与内存内哈希，
// 永不进回调/事件/日志）；本模块从不输出文件内容。
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const DEFAULT_CAPABILITY_DEBOUNCE_MS = 350;
export const DEFAULT_CAPABILITY_DEGRADED_POLL_MS = 30_000;
// 健康 watch 的低频哈希复核拍：Windows ReadDirectoryChangesW 在重负载下可能迟到/丢通知，
// 复核拍保证最终一致；内容未变时哈希去重，不产生任何事件。
export const DEFAULT_CAPABILITY_RECONCILE_MS = 15_000;

/** 缺失态哈希：文件不存在/不可读与任何真实内容互斥可判。 */
export const MISSING_CAPABILITY_HASH = "missing";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 键名摘要（防泄漏）：TOML 风格 `key = value` 行按当前表头归并为 `table.key`；
 * 值只落内存哈希，永不外传。注释行跳过。无法识别的行忽略——宁少报键，不泄内容。
 */
export function summarizeConfigKeys(text) {
  const summary = new Map();
  let table = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(.+?)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (!pair) continue;
    // 表头出现前的键属根表（TOML 语义），不归入「上一张表」——表头只向后生效
    const key = table ? `${table}.${pair[1]}` : pair[1];
    // 同键重复定义（TOML 非法但编辑器手改可能出现）：只记「出现过」，不记值
    if (!summary.has(key)) summary.set(key, sha256Hex(line));
  }
  return summary;
}

/** 前后键摘要差分 → 仅键名集合（新增/删除/值哈希变化）。 */
export function diffConfigKeys(previous = new Map(), next = new Map()) {
  const changed = new Set();
  for (const [key, digest] of next) {
    if (previous.get(key) !== digest) changed.add(key);
  }
  for (const key of previous.keys()) {
    if (!next.has(key)) changed.add(key);
  }
  return [...changed].sort();
}

/**
 * 第一期清单只有 Grok config.toml；结构上按条目标，后续可加
 * ~/.codex/config.toml、~/.claude/settings.json（各绑自己的 runtimeProfileId）。
 */
export function capabilityWatchTargets(homeDir) {
  return [
    { id: "grok-config", relPath: ".grok/config.toml", runtimeProfileId: "grok-build" },
  ].map((entry) => ({
    ...entry,
    // path.join 与 ProviderStore.liveConfigTargets 的 join(runtimeHome, ...) 同风格，
    // 保证挂接处的路径等值过滤在 Windows（反斜杠）上命中同一目标。
    path: join(String(homeDir), entry.relPath),
  }));
}

export class CapabilityWatcher {
  constructor({
    targets = [],
    onChanged = null,
    debounceMs = DEFAULT_CAPABILITY_DEBOUNCE_MS,
    degradedPollMs = DEFAULT_CAPABILITY_DEGRADED_POLL_MS,
    reconcileMs = DEFAULT_CAPABILITY_RECONCILE_MS,
  } = {}) {
    if (typeof onChanged !== "function") throw new TypeError("capability watcher requires an onChanged callback");
    this.targets = targets.map((target) => ({
      id: String(target.id ?? target.path),
      path: String(target.path),
      runtimeProfileId: String(target.runtimeProfileId ?? ""),
    }));
    this.onChanged = onChanged;
    this.debounceMs = Math.max(20, Number(debounceMs) || DEFAULT_CAPABILITY_DEBOUNCE_MS);
    this.degradedPollMs = Math.max(250, Number(degradedPollMs) || DEFAULT_CAPABILITY_DEGRADED_POLL_MS);
    this.reconcileMs = Math.max(500, Number(reconcileMs) || DEFAULT_CAPABILITY_RECONCILE_MS);
    this.states = new Map();
    this.started = false;
    this.stopped = false;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const target of this.targets) {
      this.states.set(target.id, {
        target,
        hash: null,
        lastEmittedHash: null,
        keys: new Map(),
        checking: false,
        dirWatcher: null,
        fileWatcher: null,
        debounceTimer: null,
        safetyTimer: null,
        pollTimer: null,
        reconcileTimer: null,
        degraded: false,
      });
      this.#armWatch(this.states.get(target.id));
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    for (const entry of this.states.values()) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
      if (entry.safetyTimer) clearTimeout(entry.safetyTimer);
      entry.safetyTimer = null;
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      entry.pollTimer = null;
      if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
      entry.reconcileTimer = null;
      this.#closeWatchers(entry);
    }
  }

  #closeWatchers(entry) {
    for (const key of ["dirWatcher", "fileWatcher"]) {
      if (!entry[key]) continue;
      try { entry[key].close(); } catch {}
      entry[key] = null;
    }
  }

  /** 双通道布防；任一通道创建失败/出错 → 该目标转惰性轮询（事件标 degraded）。 */
  #armWatch(entry) {
    if (this.stopped) return;
    const fileName = basename(entry.target.path);
    let armed = false;
    try {
      entry.dirWatcher = watch(dirname(entry.target.path), (_type, name) => {
        // rename 替换场景目录事件可能不带文件名；只在命中目标时触发复核
        if (name == null || String(name).toLowerCase() === fileName.toLowerCase()) {
          this.#scheduleCheck(entry);
        }
      });
      entry.dirWatcher.on("error", (error) => this.#degrade(entry, error));
      armed = true;
    } catch (error) {
      this.#degrade(entry, error);
      return;
    }
    try {
      // 文件通道：编辑器的就地写直接命中；原子 rename 替换后失效由目录通道兜底
      entry.fileWatcher = watch(entry.target.path, () => this.#scheduleCheck(entry));
      entry.fileWatcher.on("error", () => {
        // 文件句柄失效不是故障（多半是刚被 rename 替换）：关文件通道，目录通道继续
        try { entry.fileWatcher?.close(); } catch {}
        entry.fileWatcher = null;
      });
    } catch {
      // 目标文件尚不存在等：目录通道已布防即可，创建失败不算降级
    }
    if (armed) {
      void this.#check(entry, { initial: true });
      // 复核拍：通知迟到/丢失时也能收敛；哈希不变则静默，成本是一次小文件读
      entry.reconcileTimer = setInterval(() => {
        void this.#check(entry).catch(() => {});
      }, this.reconcileMs);
      if (entry.reconcileTimer.unref) entry.reconcileTimer.unref();
    }
  }

  #degrade(entry, error) {
    if (this.stopped || entry.degraded) return;
    entry.degraded = true;
    this.#closeWatchers(entry);
    if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
    entry.reconcileTimer = null;
    // watch 建不起来（父目录不存在/句柄配额耗尽）：30s 哈希轮询兜底，事件标 degraded
    console.error(
      `capability-watcher: watch degraded for ${entry.target.id} (${error?.code ?? error?.message ?? "unknown"}) — falling back to ${this.degradedPollMs}ms hash polling`,
    );
    entry.pollTimer = setInterval(() => {
      void this.#check(entry).catch(() => {});
    }, this.degradedPollMs);
    if (entry.pollTimer.unref) entry.pollTimer.unref();
    void this.#check(entry).catch(() => {});
  }

  #scheduleCheck(entry) {
    if (this.stopped) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.#check(entry).catch(() => {});
      // 安全网：Windows ReadDirectoryChangesW 在高负载下可能迟到/丢通知，
      // 一拍后主动再复核一次；内容真没变时哈希去重保证不产生多余事件。
      entry.safetyTimer = setTimeout(() => {
        entry.safetyTimer = null;
        void this.#check(entry).catch(() => {});
      }, this.debounceMs * 4);
      if (entry.safetyTimer.unref) entry.safetyTimer.unref();
    }, this.debounceMs);
    if (entry.debounceTimer.unref) entry.debounceTimer.unref();
  }

  async #check(entry, { initial = false } = {}) {
    if (this.stopped) return;
    // 在途锁：哈希在回调成功后才提交，等待期间防抖/安全网/复核拍再进一次会重复发同一事件。
    if (entry.checking) return;
    entry.checking = true;
    try {
      await this.#checkInner(entry, { initial });
    } finally {
      entry.checking = false;
    }
  }

  async #checkInner(entry, { initial = false } = {}) {
    if (this.stopped) return;
    let hash = MISSING_CAPABILITY_HASH;
    let keys = new Map();
    try {
      const content = await readFile(entry.target.path, "utf8");
      hash = sha256Hex(content);
      keys = summarizeConfigKeys(content);
    } catch {
      // 缺失/不可读 = 缺失态：参与哈希比对，内容永不外传
    }
    if (this.stopped) return;
    if (entry.hash == null) {
      // 基线快照：启动即对齐，不产生事件
      entry.hash = hash;
      entry.keys = keys;
      return;
    }
    if (hash === entry.hash) return; // 内容未变：保存≠变更，不发事件
    const changedKeys = diffConfigKeys(entry.keys, keys);
    if (initial) {
      entry.hash = hash;
      entry.keys = keys;
      return;
    }
    if (hash === entry.lastEmittedHash) {
      // Windows 重复通知：同一内容只发一次；基线哈希如实跟上，不留待处理幻影
      entry.hash = hash;
      entry.keys = keys;
      return;
    }
    try {
      await this.onChanged({
        id: entry.target.id,
        path: entry.target.path,
        runtimeProfileId: entry.target.runtimeProfileId,
        changedKeys,
        hash,
        missing: hash === MISSING_CAPABILITY_HASH,
        degraded: entry.degraded,
        at: new Date().toISOString(),
      });
      // 回调成功后才提交新哈希：回调抛错时保留旧哈希，下一拍（复核/安全网）重试
      // 把同一变更事件如实发出——若先写哈希再回调，抛错后下次 #check 会因
      // hash === entry.hash 直接返回，该次变更事件将永久丢失直到文件再变。
      entry.hash = hash;
      entry.keys = keys;
      entry.lastEmittedHash = hash;
    } catch (error) {
      // 回调失败（如事件库已关）不能杀掉监听循环——旧哈希在手，下一拍重试送达
      console.error(`capability-watcher: onChanged failed for ${entry.target.id}: ${error?.message ?? error}`);
    }
  }
}
