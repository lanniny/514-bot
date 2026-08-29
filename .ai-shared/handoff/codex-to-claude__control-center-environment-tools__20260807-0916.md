<!-- 514cc-session-id: 019fcb94-00da-7f12-8b34-e1273927d90b -->
# Control Center 环境舱与任务工具收口

## 目标

将 LO 提供的 Codex 桌面端参考图从视觉对标推进到真实能力：当前成员标签即直接收件人；每个 CLI 使用自己的 Composer 配置；Mission Control 提供 Git、智能体、进程、来源及五个任务工具。

## 落地

- `src/workbench-environment.mjs`：任务 cwd 的 Git/PR/agent/process/source 聚合，Git plan/execute 双阶段门。
- `public/environment-panel.js`：环境信息、Commit/Push、PR、智能体活动、托管进程、来源及工具入口。
- `run.sources`：创建与续聊附件结构化持久化，环境 API 仅返回 bounded 名称投影。
- 五工具：审阅复用 Mission 产物与 diff；终端复用 PTY dock；文件复用受控 workspace explorer；侧边对话同步主 Composer；浏览器限制 HTTP(S) 系统新标签且不授予 CLI 权限。
- `scripts/qa-workbench-environment.mjs`：可重复的随机端口、隔离 Git upstream、真实鉴权和四视口 Playwright QA。

## 当轮修复

Node 全量回归最初全绿，但浏览器启动链暴露 `app.js -> environment-panel.js` 返回 404，导致 token 未自举、页面脚本整体停载。根因是根级 ESM 文件未加入 `server.mjs` 静态白名单；已补映射并加入契约断言。这个问题证明静态源码测试不能替代真实浏览器加载。

QA 自身也做了两次诚实校准：折叠的 Sources 必须模拟用户展开后读取；Playwright `Page.opener()` 不是 DOM `window.opener`，改为在新标签内部验证 `window.opener === null`，避免错误断言格式化整棵 Page 对象导致 Node OOM。

安全终审继续推翻了“固定 Git argv 已足够”的判断：真实临时 remote 证明 `url.*.insteadOf/pushInsteadOf` 能把确认目标重写到另一 bare remote。现计划阶段同时读取原始与有效 push URL，不一致即 `PUSH_URL_REWRITE`；多 push URL 直接拒绝。Commit/Push 均在执行前重新认证 worktree、HEAD、index/upstream，计划在首个 `await` 前单次消费；Push 固定完整 OID/refspec，并禁 hooks、follow-tags 与 submodule push。

附件链路改为端到端结构化：自动化只保存 `sources`，触发时在 adapter 边界注入路径；私有事件保存 `sourceRefs` 供重启后脱敏，公开 run、automation、HTTP history 与 SSE 只返回名称。旧自动化 prompt 附件块会迁移，且合法的 `report (final)` 文件名不会被误剥离。自动化 cancel 和 run 清除后的全局 SSE 均有泄露回归。

最终完整 TAP 首轮抓到两处遗漏：`orchestrator.mjs` 使用 `isAbsolute()` 却漏导入，导致 8 个 Orchestrator/HTTP/Mission/worktree 用例连锁失败；事件回放又在公开投影前强制读取已清除 run，使 orphan 脱敏路径不可达。两项均已修复，Mission 的只读 workspace 夹具也从无 worktree 的非法 build 状态校正为 review，生产 `WORKTREE_NOT_READY` 边界保持不变。

## 证据

- `npm test`：757 tests / 756 pass / 0 fail / 1 explicit skip。
- `npm run validate`：13/13 valid。
- 环境舱/自动化/UI 契约定向组合：36/36；HTTP/Mission/workspace 复归：15/15。
- `node --test tests/workbench-environment-http.test.mjs`：真实随机端口覆盖 URL rewrite、多 push URL、hook、annotated tag、来源投影与重启恢复。
- `npm run qa:environment`：`ok=true`、diagnostics=[]、临时根删除、隔离服务优雅退出；桌面与 390px 截图已人工复核无叠字、透字或横向溢出。
- payload：`messageIntent=steer`、`agentId=codex-technical`，无第二套收件人字段。
- Codex Composer：6 model、7 effort、3 permission 选项。
- Git：main、ahead=1、staged=1、untracked=1；Playwright 中错误确认返回拒绝且 HEAD 不变，产品仓库未 commit/push；执行级 Push 回归只写入 QA 自建临时 bare remote。
- 四视口：1440x900、1280x800、820x1180、390x844 的 `scrollWidth === innerWidth`，Composer、Mission Control 与 Git 操作均可达。
- 截图：`apps/control-center/.qa-output/workbench-environment/`。
- 独立安全终审：`APPROVED`。

## 运行时与边界

- 未主动重启 `51400`，未对仓库 commit/push，未 runtime sync、未修改凭据。真实 Push 仅发生在 QA 自建、随后清理的临时 repo/bare remote。
- 受保护 API 的真实鉴权与 payload 证明来自自建隔离服务，不使用现有桌面私密 token。
- Browser 是系统浏览器入口，不是 CLI 浏览器权限或 Playwright 产品功能。
- 同权限本机进程仍可能在最终 workspace 认证与 Git 子进程打开目录之间竞争；未来 EventStore 外部消费者必须复用公开投影。orphan POSIX 路径兜底可能误遮 `/api/...` 类诊断文本，当前选择保守保密。

__DELTA__: 烛(Codex) | 2 | 证据：真实 redirect push 越过仅执行环境隔离并写入被重写远端，推翻“固定 argv 即足够安全”；apps/control-center/src/workbench-environment.mjs 的 URL rewrite 拒绝与 HTTP 回归完成闭环

## 2026-08-08 Provider / Proxy / Shutdown 事务收口

### 修复

- Provider CRUD、排序、故障转移、common config、导入和 `markProxyCurrent()` 全部改为候选图提交，持久化成功前不交换内存状态。
- `switchTo()` 将 CLI live 文件、`providers.json` 与 `current` 指针放入同一 publish plan；Proxy takeover 同时提交 `ccswitch-proxy.json`，runtime 只在同步 commit callback 中可见。
- Windows rename 的每次瞬时失败 retry 前都重新执行 live 快照 CAS；目标只有真实提交或 `renameCommitted=true` 才进入 `published`。
- rollback 每次 rename attempt 前验证目标仍是事务写值；外部 CLI 在提交后保存的新字节只产生明确诊断，不被旧快照覆盖。
- 慢 rename/remove 越过 deadline 后进入独立补偿窗口，恢复全部已提交 live/sidecar 目标并清理事务临时文件。
- Proxy restore incomplete 时 listener、takeover、automation、EventStore、Orchestrator 与实例锁保持可用；HTTP 在原端口、原 bearer token 上重开，允许修复 sidecar 后再次关闭。
- restore 成功后的五项清理按顺序 best-effort；失败固化为 `CONTROL_CENTER_CLOSE_FAILED`。HTTP 回开失败保留双重诊断并机械要求非零退出。

### 验证

- Provider：42/42。
- App / Shutdown / 真实 server：6/6；真实 upstream 使用 live CLI takeover token 完成 200 转发。
- CC-Switch 整域：142/142。
- `ccswitch-proxy.test.mjs`：连续 10 轮，每轮 31/31。
- 全量：803 tests / 802 pass / 0 fail / 1 explicit skip。
- `npm run validate`：13/13 valid；CC-Switch 账本 288 项，157 equivalent / 128 adapted / 3 blocked_external_trust。
- 核心 12 文件：`node --check` 12/12；冻结 SHA 首末两次均 12/12；最终独立复审 `APPROVED`。
- 残留：`.test-app-close-*` 0、`.test-shutdown-server-*` 0、事务 `.tmp` 0；历史 `.test-*` 与 `.scratch` 未删除。

### 边界

- 未 commit、push、runtime sync、重启既有桌面进程或修改凭据。
- 3 个 updater 继续 `blocked_external_trust`，没有借用上游签名材料。
- 原环境舱 Git URL rewrite 的 `DELTA=2` 保留在上方；本节是独立的 Provider/Proxy 事务纠错记录。

__DELTA__: 烛(Codex) | 2 | architecture | 证据：apps/control-center/src/providers.mjs:802 与 src/atomic-rename.mjs:68 的 retry-attempt CAS、published 提交判定和 rollback 写值验证，推翻“publish 前单次复核已经足够”的旧判断
