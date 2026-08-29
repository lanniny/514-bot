<!-- 514cc-session-id: 019fcb94-00da-7f12-8b34-e1273927d90b -->

# 协作台直接收件人、CLI 操作台与诊断安全收口

日期：2026-08-07

## 结论

- 仓库源码、全量测试、配置校验和隔离 Playwright 已完成机械验证；替代独立审查最终 `APPROVED`，无阻塞项。
- 当前成员标签是唯一直接收件人；`@` 只追加结构化额外协作者，不会替换活动成员。
- 模型、effort、权限、Build 写权限、slash 目录和 CLI 操作台全部沿 `memberId -> runtimeProfileId -> adapter.id` 绑定同一成员。不支持的能力隐藏或冻结，不伪造档位。
- CLI 侧能力以白名单诊断和事务化配置进入协作台；未开放任意 Shell、安装、更新、删除或登录写操作。

## 核心契约

1. `apps/control-center/public/app.js:11756` 只渲染真实逻辑成员；`:10159` 固定 `startAgentId` 来自活动成员，`:2198` 保证 `@` 不覆盖直接收件人。
2. `apps/control-center/src/orchestrator.mjs:189` 统一读取持久化 `executionOwnerId`；`:530`、`:633` 让 turn、model 和 effort 绑定同一成员/席位。legacy continue 也不再回退 coordinator。
3. `apps/control-center/src/orchestrator.mjs:3046` 服务端同时校验 pending ask 的 asker 与 ask id；其他成员只能显式 steer，不能冒充 answer。
4. `apps/control-center/src/adapters/manifest.mjs:444` 从 adapter manifest 解析固定诊断 argv；`apps/control-center/src/agent-actions.mjs:43` 约束 action id、成员席位互斥和全局容量，`:94` 显式 `provider: null`，不继承 Provider 凭据。
5. `apps/control-center/src/structured-redaction.mjs:56`、`:175` 对 JSON/JSONL/YAML 和 argv 敏感参数统一脱敏；纯结构化 `args: ["--token", "secret"]` 与 `--api-key=secret` 不再绕过扫描。
6. `apps/control-center/src/providers.mjs:123` 只在受类型约束的 `apiKeyField` 中保留 `ANTHROPIC_API_KEY` 环境变量引用；普通敏感字段仍输出 `[REDACTED]`。
7. `apps/control-center/tests/runtime-seats-http.test.mjs:275` 新增不存在成员的模型目录 HTTP 契约：固定返回 `404 + SOURCE_NOT_FOUND`。

## 独立审查

- 首个 `codex-reviewer` 外部侧线失败：`403 Forbidden: insufficient balance`，端点 `https://sub.micuapi.ai/v1/responses`；该失败不计作审查通过。
- 替代独立 agent 复核结果为 `APPROVED`：未发现直接收件人、身份链、白名单诊断、事务配置或 pendingAsk 所有权断链。
- 替代审查定向 TAP 输出 `24 passed / 0 failed`；其执行包装层在完整汇总后仍报 10 秒超时。主线程随后用非登录 shell 重跑全量并取得真实退出码 0，消除了产品回归不确定性。
- 独立审查唯一建议是补齐不存在成员的模型目录 HTTP 回归，已落实到 `runtime-seats-http.test.mjs:275`。

## 机械验证

- `npm test`：`729 tests / 728 pass / 0 fail / 1 explicit skip`，退出码 0。
- 定向安全/协作回归：`120 pass / 0 fail`；覆盖 action 脱敏与容量、Provider、运行席位、编排和 Mission Control。
- `npm run validate`：`13/13 valid`；CC-Switch 账本 `288` 条，`157 equivalent / 128 adapted / 3 blocked_external_trust`。
- 隔离 Playwright：`apps/control-center/.qa-output/cli-seat-continuation-security-final/result.json` 为 `ok=true`、`diagnostics=[]`、`isolation.gracefulShutdown=true`、`isolation.tempRootRemoved=true`。
- QA payload：Kimi 直接收件人为 `kimi-frontend`，`@Codex` 仅进入 `requestedAgentIds=[codex-technical]`；模型 `kimi-code/k3`，无伪造 effort。Codex effort 为 `low/medium/high/xhigh/max/ultra`。
- QA CLI 操作台：白名单版本动作真实返回 `v24.4.1`；Codex 席位默认模型、effort 与权限事务写盘后读回；Claude 提问卡回答 payload 带正确 asker、`messageIntent=answer` 与 `answerToAskId`。
- 390px：活动成员可见，body/root/viewport 均为 390，无横向溢出；隔离 QA 共生成 13 张桌面/移动截图。
- 本轮相关文件的 `git diff --check` 退出码 0，仅有 LF/CRLF 提示。

## 运行态与边界

- `http://127.0.0.1:51400/` 当前 HTTP 200，标题 `514 Forge · Control Center`；监听者为 Node PID `13004`，启动于 `2026-08-07 05:10:41`。
- 进程命令行为 `node --experimental-sqlite I:\514claude\514cc\apps\control-center\server.mjs`，启动时间晚于最新后端源码写入时间 `2026-08-07 05:02:04`。未携带 token 的 `/api/health`、`/api/teams` 与模型目录探针均按边界返回 401，因此没有冒用凭据做生产态写操作。
- 本轮未终止或重启 `51400`；PID 变化来自本轮之外。源码加载时间证据成立，但没有使用私密 token 做受保护 API 的生产态行为读回。
- 全 `apps/control-center` 的 `git diff --check` 仍会被既有 `public/styles.css` 大规模行尾空白/CRLF 债淹没并在 300 秒超时；该文件不属于本轮最后修复集合，未擅自制造一万行格式化 churn。
- 未执行 runtime sync、commit、push、reset、checkout、安装、更新、删除或登录写操作；无关脏工作树保持不动。

__DELTA__: 烛(Codex) | 2 | correctness | 证据：apps/control-center/src/structured-redaction.mjs:56 修复纯 JSON/YAML argv 敏感参数泄漏，推翻此前“结构化诊断已完整脱敏”的判断
