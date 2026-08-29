<!-- 514cc-session-id: 20260830-0200-f052-f053 -->

# F-052 凭据清单 / F-053 脱敏契约 · 四节评审

发：烛（Claude 面） · 收：全体 · 2026-08-30 02:00

## 一、致命问题

**1. 泄露不是"曾经"，是"正在"——且清理提交未推送。**

`.ai-shared/control-center-preview/data/ccswitch-proxy.json` 的 CC-Switch 代理 token
（`tEP1_` + 38 位，43 字符，监听 `127.0.0.1:15721`）：

| 事实 | 证据 |
|---|---|
| 引入提交 `6077930`（2026-08-13 10:16）已在 `origin/main` | `git branch -r --contains 6077930` → `origin/main` |
| 远端当前仍可取到明文 | `git show origin/main:<path>` → token 长度 43，匹配 `^tEP1_[A-Za-z0-9_-]{20,}$` |
| 清理提交 `1876bf9`（2026-08-30 01:38）**未推送** | `git branch -r --contains 1876bf9` → 空 |
| 暴露时长 | 约 **16 天**，且此刻仍在持续 |

**必须做**：① 立即轮换 token；② 轮换后推送 7 个本地提交；③ 历史对象仍需
`git filter-repo` + 强推（强推不替代轮换）。

**2. 本轮审计自身犯过一次方法论错误，必须记账。**

我一度用 `git ls-files` / `git check-ignore` 判定"该文件未被追踪 → 未泄露"，
差点把既有的 P0 记录改成"误判"。**索引干净 ≠ 历史干净。** 正确判据是
`git log --all -- <path>` 与 `git cat-file -e <ref>:<path>`。已写入 context.md 作为教训。

**3. `sanitizeForPersistence` 三处实测故障，位于写盘关键路径。**

调用点：`event-store.emit`、`bus`、`orchestrator#persistRun`、`approval-broker.request`。
它抛异常 = 整条事件流丢数据，不是"少脱敏了一点"。

- `src/redaction.mjs:187`（修改前）循环引用 → `RangeError: Maximum call stack size exceeded`；
  深嵌套 2000 层同样溢出。
- `src/redaction.mjs:194`（修改前）`Buffer` 走 `Object.entries` 分支 → 被拆成
  `{"0":115,"1":107,...}` 字节索引字典：数据毁形，**且绕过全部字符串脱敏规则**。
- `src/redaction.mjs:195`（修改前）Map/Set/Date/URL/Error 静默压成 `{}`；BigInt 抛
  `TypeError: Do not know how to serialize a BigInt`。

**放大器**：`orchestrator.mjs:2003` 的 `Object.assign(run, safe)` 把脱敏克隆回写进活的
run 对象——所以每一条"落盘数据被改坏"同时也是"运行时状态被改坏"。

## 二、建议改进

1. **推 `scripts/secret-audit.mjs` 进 CI**（`--scope=tracked`，退出码即结论）。当前基线
   950 文件 / 0 命中，是可以直接卡死的好基线。
2. **`--scope=worktree` 的 1746 处命中集中在本机已 gitignore 的备份目录**，值得单独做
   一次本机清理决策——它们不进远端，但让工作树长期处于高风险态。
3. **`orchestrator.mjs:2003` 的 `Object.assign(run, safe)` 语义偏危险**：脱敏结果回写
   活对象，等于让"落盘视图"反向污染"运行时视图"。当前 run 对象无敏感键所以无碍，但
   这是一枚定时炸弹。建议后续改为只把 `safe` 用于序列化，不回写。
4. **F-053 覆盖面仍有盲区未修**：无前缀高熵凭据脱离键名上下文时，`scrub` 不认
   （`tEP1_...` 裸串在日志/PTY/SSH 输出里零检测）。我在审计脚本里补了这层，但**没有
   并进运行时 `scrub`**——因为 `scrub` 的误报代价是正文被改写，风险远大于审计脚本。
   是否要加、以及用什么阈值，需要单独决策，不在此轮擅自定。
5. **`core.hooksPath` 未启用 = 闸门不存在**。新环境 clone 后必须执行
   `git config core.hooksPath .githooks`。建议收敛进项目初始化脚本，别靠人记。

## 三、可保留

1. `sanitizeForPersistence` 的**覆盖面**是扎实的：键名敏感 + 已知前缀 6 条 + 赋值型
   （JSON/YAML 块/CLI）+ PEM 边界 fail-closed + URL userinfo，边界考虑到位
   （数字/布尔计量字段不被 `token` 键名误伤）。**本轮改的是健壮性，不是覆盖面。**
2. `.githooks/pre-commit`（F-004）设计克制：只扫增量新增行、模式库小、有占位符白名单、
   命中时输出脱敏（只给前缀和长度，不让完整值二次落终端）。**且 `tEP1_` 已在模式库里**
   ——说明当时就识别到了这类 token，泄露发生在钩子启用之前。
3. `secret-audit.mjs` 复用钩子的 `PATTERN`/`PLACEHOLDER` 而非自建模式库：改钩子即改审计。
   解析失败直接退出 2，不用弱规则报"干净"。
4. 熵阈值经过语料实测校准，不是拍脑袋：UUID/runId ≈3.6、SHA-256 ≤4.0，均被 4.5 挡下；
   `package-lock.json` 的 sha512-base64 完整性字段（熵 5.2+）按文件排除。
   未做这步排除时误报 354 条，排除后 7 条，标注夹具后 0 条。

## 四、总评

这一轮的产出分两半，价值密度差很大。

**工具侧（F-052）是净增**：`scripts/secret-audit.mjs` 把"仓库里有没有密钥"从一次性人工
排查变成了可重复、可进 CI 的机器判据，并且和既有钩子共用一套模式库，不会各说各话。
基线 0 命中是好消息，但**这个 0 是在 7 处测试夹具被显式标注之后才成立的**——所以它是
"已知且受控的 0"，不是"碰巧没扫到的 0"，两者含金量不同。

**代码侧（F-053）修的是真 bug，但都是被现有测试完全覆盖不到的盲区。** 452 行的
`redaction-jsonl.test.mjs` 一条都没碰到循环引用、Buffer、Map/Set。这说明测试覆盖的是
**设计意图**（该遮的遮住了），没覆盖**宿主对象的边界行为**。新增 4 条测试把它们钉住了。

**最该被记住的不是任何一个修复，是那次方法论翻车。** 我用 `git ls-files` 得出"未泄露"
的结论，差点把一条正确的 P0 记录改成"误判"。如果当时直接改了 context.md，这个 token
很可能就这么被判定为"虚惊一场"而不再轮换——而它此刻正躺在公开仓库里，已经躺了 16 天。
判断泄露看的是历史，不是索引。

## 待 LO 拍板

1. **轮换 `tEP1_`** 代理 token（我做不了，需要你在 CC-Switch 侧重新生成）。
2. **授权推送** 7 个本地提交（SSH 被 fake-ip 代理挡住；HTTPS 远端已配好，走 127.0.0.1:7897）。
3. 是否把 `secret-audit.mjs --scope=tracked` 接进 CI。
4. 是否要把高熵检测并进运行时 `scrub`（误报代价高，我倾向不做，需你决策）。
5. `.ai-shared/backups/` 等本地备份目录（1746 处命中）要不要做一次本机清理。

`__DELTA__`: 烛(Claude) | 2 | 证据：`.ai-shared/context.md` P0 条经历史复核（非索引）确认
泄露仍在线且清理未推送，推翻"轮次内一度误判为未泄露"的结论
