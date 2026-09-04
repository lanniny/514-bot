<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->

# v50 许可通道 · 全链路完成（含审批卡）

**日期**：2026-09-04
**范围**：`apps/control-center`（前端审批卡渲染）
**前序**：`synthesis__v50-permission-channel-wired__20260904-2050.md`

---

## 一句话

审批卡接上了。**从"CLI 需要许可"到"操作者看到卡片并做选择"的完整链路已闭合**，
48 项测试全绿。唯一未做的是在一次真实 Claude run 里跑通（额度所限）。

---

## 本轮交付

发现审批卡本身**不需要新建** —— `botApprovalCardMarkup` / `approvalInlineMarkup`
按 `item.method` 通用处理，我的新方法会自动渲染。真正缺的是两件事：

### 1. 参数渲染：通用键值表对这类请求不够用

通用分支会把 `input` 压成一坨 JSON —— **`rm -rf /` 和 `ls` 长得一样长**，
操作者无从判断。新增 `approvalToolPermissionMarkup`，按工具语义挑出决定性字段：

| 工具类型 | 主体呈现 |
|---|---|
| 命令类（`command` / `cmd`） | 命令本身用 `<pre>` 呈现，与既有命令审批卡一致；`description` 作副标 |
| 写盘类（`file_path` / `filePath` / `path` / `notebook_path`） | 目标路径 + 内容预览（截 400 字符）+ **内容规模**（判断改一行还是重写整个文件）|
| 认不出的 | 退回完整键值表 —— **看不懂总比看不见强**，绝不隐藏参数 |

### 2. 方法标签：裸协议名不是给人看的

`claude/toolPermission/requestApproval` 是给协议看的。新增 `APPROVAL_METHOD_LABELS`
（"使用工具" / "执行命令" / "扩大权限面"…），**两处审批 UI 都用同一函数**
（bot 卡 + 安全诊断页），安全页保留原方法名作 `title` 便于排障对协议。

未登记方法**原样返回方法名** —— 宁可难看，不可显示成别的东西。

---

## 真数据渲染验证（不只源码断言）

把三个纯函数抽到 node 里用真实参数跑了一遍：

```
Bash    → <pre>rm -rf /tmp/x</pre> + 说明「清理临时目录」
Write   → 目标文件 I:/a/b.txt + 内容预览 + 「3 行 / 17 字符」
WebFetch→ 完整键值表（未识别工具的兜底）
密钥    → curl -H "key: [REDACTED]"   ← redact 真的生效
标签    → "使用工具" | 未登记的原样返回 "unknown/x"
```

---

## 一次差点改错

`grep escapeHtml(item.method)` 找到第二处显示方法名的地方，正要改成标签函数时，
读了上下文才发现那是**诊断表的 HTTP method（GET/POST）**，不是审批方法。

`.method` 这个字段名在两个完全不同的语境里都成立 —— 只按字段名匹配就会改错。

---

## 全链路现状

```
Claude CLI ──> 每轮专属 MCP server ──> 具名管道 ──> 内核端点 ──> ApprovalBroker ──> 审批卡
              (runId 内联不经 argv)   (路径随机)    (fail-closed)   (inbound:true)   (按工具语义渲染)
```

**48 项测试**（本程 v50 累计），其中 17 项跑真进程或真管道：

| 层 | 文件 | 项 |
|---|---|---|
| PPT 线协议 + v1 闸 | `permission-prompt-wire.test.mjs` | 35 |
| 真实帧回归 | `permission-prompt-frames.test.mjs` | 9 |
| 脚本生成器 | `permission-server-script.test.mjs` | 14 |
| 管道端点 | `permission-endpoint.test.mjs` | 18 |
| 脚本↔端点端到端 | `permission-link-e2e.test.mjs` | 7 |
| adapter 接线 | `claude-permission-channel.test.mjs` | 10 |
| 审批卡渲染 | `approval-tool-permission-card.test.mjs` | 13 |

```
2278 项 / 2275 通过 / 1 失败（先前债）/ 2 跳过
ui:lint 7 条规则零新增违规 · api:audit ✓
```

---

## 仍未做（显式登记）

| 项 | 说明 |
|---|---|
| **真实 CLI 联调** | 全链路已用真进程与真管道测过，但**没在一次真实 Claude run 里端到端跑通** —— 本程额度已撞 5h 上限（WebFetch 报 429）。这条不标完成 |
| 回程进哈希链 | `actionHash` 只覆盖入站。v1 禁提权字段后回程只剩 `{behavior, message}`，风险大幅收窄但覆盖仍应做 |
| "总是允许" | 需 Console 侧规则存储，不碰 CLI 权限存储 |
| `conversations-http.test.mjs:200` | 先前债 |

---

## 本轮元教训

**字段名相同不代表语义相同。** `item.method` 在审批卡里是协议方法，在诊断表里是
HTTP 动词。`grep` 给出的两处命中长得一模一样，只有读上下文才能分辨 ——
**按字段名批量改是危险的，哪怕改动本身很小。**

---

__DELTA__: 主驾自评(Claude) | 1 | 证据：审批卡链路闭合（app.js 新增 approvalToolPermissionMarkup 按工具语义渲染 + APPROVAL_METHOD_LABELS 两处 UI 统一消费），真数据渲染验证四种形态含密钥脱敏；并在改第二处 `.method` 前读上下文发现那是诊断表的 HTTP 动词而非审批方法，避免了一次同名字段的误改
