# handoff：重启爆内存修复（主驾自评 · LO 报障驱动）

- 时间：2026-07-20 14:30
- 范围：`apps/control-center`（src/child-registry.mjs、src/health.mjs、src/adapters/grok-mcp.mjs）
- 触发：LO「现在重启服务之后会产生非常大量的内存占用导致爆内存，导致中断」（7-19 同类报障复发）

## 根因（三条叠加，一条是主驾上午亲手引入）

1. **【主驾上午引入】孤儿收割静默失效**：上午修烛致命1 时把 pid 复用防护改为双判据 fail-closed（镜像 + `registeredAt` 创建时间），但**旧格式台账（v1 无 registeredAt 字段）会全体判"不可认证"跳过**——过渡期重启一次，孤儿一条收不了且台账被清空覆盖，旧树彻底失忆成幽灵。诚实记账：这是我修一个致命时引入的回归，烛评审后我没有对"磁盘上既存数据"做兼容推演。
2. **【v3.5 结构债·爆内存大头】健康检查拉起满 MCP codex 树**：`grok-search` 的 `health()` 每次 `/api/bootstrap`、`/api/health` 都 `createThread()` → 启动 `disableMcp: false` 的独立 codex app-server（serena/grok-search/ace-tool 全部 MCP 孙子，GB 级）。页面一开就常驻一棵满配树；强杀 server 后树成孤儿；重启再开页面又拉一棵——**孤儿收割一失效（根因1），旧树+新树叠加即爆**。
3. **【放大器】探针风暴**：`HealthService.all()` 对全 profile `Promise.all` 并发 `--version` 探针（六七个 CLI 各 100-300MB 冷启动峰值同时拉起）+ TTL 失效瞬间多路请求（bootstrap+health+SSE 重连）各自触发一轮，无并发去重。

## 修复

1. child-registry：**旧格式台账兼容**——条目缺 `registeredAt` 时回退台账文件级 `updatedAt` 做时间判据（v1 也有该字段，登记必然早于落盘），双判据语义不变、过渡期不失效。
2. child-registry：**批量身份探针**——`queryProcessIdentities(pids)` 单次 PowerShell `Get-Process -Id p1,p2,...` 查全台账（原实现逐 pid 各起一个 powershell，启动路径拖慢且叠内存）；探针超时/失败=全体不可认证 fail-closed。
3. grok-mcp：**health 惰性探针**——host 未启动时不再 `createThread`，报 `dormant`（env 已验证 + available:true，工具清单留到真执行时验证，失败仍如实抛）。健康检查从此永不为 grok-search 付满 MCP 树的启动成本。
4. health：**限并发 2 + inflight 去重**——探针风暴消除，TTL 失效瞬间多路请求合流到同一次探测。

## 验证（全部实机）

- 批量探针：自身 pid 返回 `node.exe`+精确 StartTime，死 pid 返回 null。
- 端到端：起真 server → 台账 7 条僵尸记录全探测为已死并清账（children.json 归空）→ `GET /api/bootstrap` 后 `grok-search: dormant`、**系统进程表 codex.exe 零条目**（满 MCP 树未被拉起）→ server 本体 54MB。
- `node --test` 139/139。
- 遗留如实：kimi-frontend 探针报 `spawn kimi ENOENT`（该 shell PATH 无 kimi，环境事实非本轮改动）；测试套件用 `child.kill()` 强杀 server 不走 shutdown，若测试触发过 host 启动其子树依赖下次 reap 兜底（临时 dataRoot 台账随目录删除，此路径收不了——测试环境限制，生产 dataRoot 固定不受影响）。

__DELTA__: 主驾自评(Cursor) | 2 | performance | 证据：child-registry.mjs 旧台账 fail-closed 全跳过=主驾上午修复引入的收割失效回归（被 LO 报障推翻"已修好"判断）；grok-mcp.mjs health() 每 bootstrap 拉起满 MCP codex 树（v3.5 结构债坐实为爆内存大头）
