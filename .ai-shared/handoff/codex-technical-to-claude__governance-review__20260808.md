<!-- 514cc-session-id: 019fe00d-4c3b-7262-bf3c-352057797c61 -->
# Console 2026-08-08 安全与正确性评审

- **评审席位**：Codex 技术执行 / 烛独立复核
- **评审模式**：security + correctness + adversarial behavior probe
- **评审范围**：`public/api.js`、`public/rail-tools.js`、`public/modules/rail-panels.js`、`public/forge/rail-tools.css`、`public/environment-panel.js` 及直接集成和测试
- **结论**：`CHANGES_REQUESTED`

## 致命问题

1. **[高] 文件页存在可稳定复现的同 run 请求乱序，旧目录会覆盖用户后选目录。** `loadFiles()` 仅在响应后校验 run id，没有记录请求代次、owned path 或取消前一请求；A -> B 快速点击且 B 先返回时，界面先显示 `/B`，A 的迟到响应随后把 `filesCurrentPath`、`filesEntries` 和 DOM 改回 `/A`。证据：`apps/control-center/public/modules/rail-panels.js:248`、`:262`、`:263`、`:264`。当轮 deferred Promise 探针实测 `afterB=/B`、`afterLateA=/A`、`staleOverwrite=true`。应使用独立 files controller/generation，并在成功、失败两条路径同时校验 owned `{runId,path,generation}`。

2. **[高] 审阅页用可变共享 `controller` 判断旧请求归属，被 abort 的旧请求会误报“差异读取失败”。** 第二次加载在 `controller?.abort()` 后立刻把共享变量换成新 controller；旧请求进入 `catch` 时读取的是新 controller 的 `signal`，同一 run 下不会被忽略。证据：`apps/control-center/public/modules/rail-panels.js:170`、`:171`、`:173`、`:177`、`:178`。当轮行为桩已复现 `flashedFailure=true` 和 `差异读取失败 / aborted`。应捕获局部 `ownedController` 或 generation，并显式忽略 owned AbortError；补 deferred Promise 回归，不能只靠源码正则。

3. **[交付阻断] 五个目标源码和三份目标测试当前全部是 untracked。** `app.js` 已导入这些模块，`index.html` 已引用新 CSS，`server.mjs` 已登记新静态入口，但 `git status --short --untracked-files=all` 对 `api.js`、`environment-panel.js`、`rail-tools.js`、`modules/rail-panels.js`、`forge/rail-tools.css` 及三份测试均返回 `??`。证据：`apps/control-center/public/app.js:3`、`:4`、`:5`，`apps/control-center/public/index.html:28`，`apps/control-center/server.mjs:798`、`:799`。任何只收 tracked diff 的交付都会得到模块 404/整页 ESM 停载；进入提交或打包前必须机械核对清单，不能只看 `git diff`。

## 建议改进

1. **diff 的本地上限会静默隐藏文件并制造部分统计。** `parseUnifiedDiff(data.diff).slice(0, 40)` 丢弃第 41 个及以后文件，却只提示单文件 600 行截断和后端 `data.truncated`；本地文件上限没有提示。单文件达到上限后 `additions/deletions` 也停止累计，文件头看起来像完整统计。当轮 605 条新增探针得到 `renderedLines=600`、`perFileAdditions=599`，而全局 stat 为 605。证据：`apps/control-center/public/modules/rail-panels.js:47`、`:119`、`:140`、`:145`、`:147`。保留上限可以，但必须显示“仅展示前 40 个文件/前 N 行”，文件统计应标成部分值或来自完整 stat。

2. **文件页吞掉了后端目录截断事实。** 后端返回 `truncated` 与 `bounds`，前端目录分支只消费 `entries`；超过上限时用户会把不完整目录误认成完整目录。证据：`apps/control-center/src/workspace-explorer.mjs:479`、`:489`、`:490`，`apps/control-center/public/modules/rail-panels.js:265`、`:267`。应在目录树底部显示截断说明和上限。

3. **工具菜单展示了没有接线的快捷键。** `Ctrl+T`/`Ctrl+P` 被渲染为浏览器/文件快捷键，但 rail controller 只处理 Escape，应用层只接了审阅 `Ctrl+Shift+G` 与侧边对话 `Ctrl+Alt+S`；前两者还是浏览器保留快捷键。证据：`apps/control-center/public/rail-tools.js:18`、`:20`、`:21`、`:178`，`apps/control-center/public/app.js:12110`、`:12113`、`:12116`。实现可用的非冲突快捷键，或删除虚假提示。

4. **`request()` 应补同源约束作为纵深防御。** 当前会给任意传入 URL 附加 Bearer；当轮 Node 桩调用绝对 URL 观察到 `Authorization: Bearer review-secret`。当前生产 CSP `connect-src 'self'` 且现有调用点均为本地 API，因此未构成已发现的现实泄露；但公共客户端最好在加 token 前用 `new URL(path, location.origin)` 校验同源/允许的 API 前缀。证据：`apps/control-center/public/api.js:96`、`:100`，`apps/control-center/server.mjs:500`。

5. **修正“影响 16 处 request 调用”的证据口径。** 当前字面 inventory 中，五个命名面板仍有 14 个 `request(... body: JSON.stringify(...))` 调用，终端 resize 已改为对象 body；全目录 16 个 `body: JSON.stringify` 命中里另两处是 bootstrap 的直接 `fetch`，不经过 `request()`。这不否定根因和修复，但任务卡的影响计数不可作为机械验收事实。证据：`apps/control-center/public/api.js:147`、`:150`，`apps/control-center/public/app.js:601`、`:604`，`apps/control-center/public/terminal-panel.js:217`、`:243`、`:256`。

6. **为 rail panels 增加行为测试。** 现有 `workbench-rail-and-tools-contract.test.mjs` 主要锁源码形状，无法发现 deferred Promise 乱序、AbortError 归属、本地 40/600 截断和目录截断提示缺失。证据：`apps/control-center/tests/workbench-rail-and-tools-contract.test.mjs:164`、`:177`。

## 可保留

1. **双重序列化修复正确。** `request()` 对对象只序列化一次、对已序列化字符串原样透传，并保持 JSON Content-Type；三条真实 fetch-init 行为测试通过。证据：`apps/control-center/public/api.js:102`、`:107`，`apps/control-center/tests/api-request-body.test.mjs:26`、`:36`、`:47`。

2. **环境舱的异步归属防护正确。** 它同时捕获 owned generation、owned run id，并在成功/失败两条路径校验，不存在 rail review 的共享 controller 误判。证据：`apps/control-center/public/environment-panel.js:214`、`:216`、`:217`、`:228`、`:233`。

3. **当前目标渲染未发现可利用的 DOM 注入。** diff、目录、文件预览、环境字段均在进入 HTML 前转义；头像 raw markup 的当前调用者只返回固定 CLI sprite 或已转义双字 fallback。外链入口限制为 HTTP(S)、断开 opener，服务端 CSP 还限制 `connect-src 'self'`。证据：`apps/control-center/public/modules/rail-panels.js:135`、`:143`、`:227`、`:245`，`apps/control-center/public/environment-panel.js:181`、`:186`，`apps/control-center/public/app.js:7188`、`:11041`、`:11050`。

4. **工作区读取服务端边界可以保留。** 前端只消费受控 workspace 投影；服务端已有根路径证明、链接/硬链接检查、敏感名过滤和高熵内容拒绝，本轮未发现 rail 新模块绕过这些边界。

## 总评

本轮不能批准。API 双重序列化修复与环境舱 generation 保护通过；阻断点集中在新 rail panels 的两个真实竞态和 untracked 交付面。优先修 `loadFiles`/`loadReview` 的请求所有权，再补 40/600 与目录截断诚实提示和行为回归。

验证证据：

- `node --check public/api.js public/rail-tools.js public/modules/rail-panels.js public/environment-panel.js` 分文件执行均 `exit 0`。
- 定向测试：18 tests / 18 pass / 0 fail。
- `node scripts/validate-control-configs.mjs`：13/13 valid。
- 无落盘行为探针：目录乱序 `staleOverwrite=true`；审阅旧 abort `flashedFailure=true`。
- 沙箱内全量测试因夹具 `mkdtemp` 被拒绝得到 821 tests / 470 pass / 350 `EPERM` fail / 1 skip，不能作为代码失败或通过。
- 沙箱外全量复跑在返回 TAP 总结前被会话中断，未取得可信全量结论；遗留测试服务 PID 27208 的进程树已精确识别，终止仍等待 LO 明确确认。
- 独立 `codex-reviewer` 复核确认两个竞态和截断诚实性问题；没有修改源码。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | governance | 证据：apps/control-center/public/modules/rail-panels.js:248 行为探针推翻“右栏工具页已完整收口”判断，旧目录响应可覆盖用户后选目录
