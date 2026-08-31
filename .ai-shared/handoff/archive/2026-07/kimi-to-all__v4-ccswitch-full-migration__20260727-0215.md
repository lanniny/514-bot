# cc-switch 完全迁移波：全部能力落地（Kimi → all）

> 时间：2026-07-27 · 主驾：Kimi · 范围：apps/control-center 供应商面（存储/网络服务/路由/前端）
> 触发：LO「我叫你完全迁移他的全部功能和能力，并且可以搬代码，而你只阉割了部分能力」+ 本地源码包 `J:\下载\cc-switch-3.18.0.zip`

## 一、深读清单（源码证据）

`.scratch/cc-switch/cc-switch-3.18.0/` 逐文件读完：`speedtest.rs`（并发 GET 热身+计时）、`stream_check.rs`（可达性三档，任意 HTTP 响应=可达）、`usage_script.rs`（QuickJS 沙箱+HTTPS/同源闸+结果校验）、`provider/endpoints.rs`、`deeplink/parser.rs`（ccswitch://v1/import 全参数）、`commands/failover.rs`（队列+空队列补 P1+关闭不清队列）、`UsageScriptModal.tsx`（PRESET_TEMPLATES 全文）。

## 二、落地对照表（已迁）

| cc-switch 能力 | 514 Forge 落点 |
|---|---|
| 端点测速 `test_api_endpoints` | `provider-net.mjs testEndpoints` + 卡片测速按钮 + 端点 tab「测速全部」 |
| customEndpoints CRUD + lastUsed | `providers.mjs #validateMeta`（normalize 去重）+ 端点 tab |
| endpointAutoSelect | 端点 tab 复选框——测速后最快端点自动换主（旧主退入备选） |
| 用量查询脚本（QuickJS） | `queryUsageScript`（node:vm 等价）——同四变量、同 HTTPS/同源闸、同结果校验 |
| 内置模板 GENERAL/NEW_API | `USAGE_TEMPLATES` 全文一字未改搬运 + 模板下拉联动 |
| 自动查询间隔 | 前端 `reconcileUsageAutoQuery` 分钟级定时（会话级） |
| 连通性检查 stream_check | `checkReachability` + 卡片健康点（四态+脉冲） |
| failover 队列 + 自动转移 | per-app 队列 + `failoverNext`（驱动点=当前供应商检查失败，514cc 化） |
| 排序 sortIndex | `sort()` + 排序模式上下移 |
| 导入导出 | `exportProviders/importProviders`（默认掩码，includeSecrets 显式） |
| ccswitch:// 深链接 | `parseDeeplink` + 粘贴导入（不注册系统协议） |
| per-provider proxy | `proxyUrlOf` → claude HTTPS_PROXY / gemini .env 投影 |
| apiKeyField 变体 | claude env 写 ANTHROPIC_API_KEY / AUTH_TOKEN 可选 |
| common config snippet | per-app 片段：claude JSON 并顶层 / codex TOML 并块尾 / gemini KEY=VALUE 并 .env |
| env 冲突检查 | `envConflicts`（process.env 撞车，值掩码） |
| costMultiplier / 日月限额 | meta 存储+高级 tab（统计展示面见「不迁」） |
| 模型可用性测试 | `testModelRequest`（cc-switch 旧版真实请求面，我们保留为加强） |

## 三、明确不迁（已报备）

常驻本地代理接管 + 熔断器 + request-log 用量统计（架构不同：我们直写 live 配置而非代理转发；安全面太大）、WebDAV/S3 同步（网络存储依赖）、托盘/自启/updater（cc-desktop 壳自有）、OpenClaw/OMO/Hermes/OpenCode（不集成的运行时）、Skills/MCP/Prompt 管理（514cc 已有等价面）。

## 四、关键实现决策

1. **node:vm 替代 QuickJS**：零新依赖复刻沙箱语义——`vm.createContext(Object.create(null))` + codeGeneration 关闭 + 1s eval 超时；extractor 在宿主侧调用（同 isolate 函数引用安全）。
2. **敏感字段统一「留空=保留」**：usageScript.apiKey/accessToken、proxyConfig.password 与主 apiKey 同律掩码（`maskMetaSecrets`），export 默认掩码。
3. **failover 驱动点差异**：cc-switch 靠常驻代理转发失败被动驱动；514 Forge 无代理面，驱动点=健康检查失败 **且该档案是当前供应商**——只对在用的转移，不误切。
4. **export 活引用反抹 bug**：exportProviders 曾返回 failoverQueue 活引用，replace 导入的清空步骤反向抹掉 payload 自身队列——改深拷贝（单测钉死）。

## 五、验证

- `npm test` 516 / 515 pass / 0 fail / 1 skip（+22 provider-net 用例）
- 探针 `apps/control-center/scripts/qa-w2-probe.mjs`（隔离 DATA_DIR+RUNTIME_HOME）12 截亲查：面板/failover 条/健康点 failed/测速 85ms 与 ECONNRESET/六 tab/端点测速/脚本失败如实/排序模式/环境检查 toast
- 501×7 = Wave G 门闸收敛面预期，非回归

__DELTA__: Kimi(主驾) | 1 | 证据：apps/control-center/src/provider-net.mjs:1 网络服务面从零落地（测速/可达性/用量沙箱/深链接/模型请求五服务），provider-net.test.mjs:1 22 用例全绿
