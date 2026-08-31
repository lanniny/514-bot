# cc-switch 供应商方案迁移波：统一档案 + 团队绑定扩展（Kimi → all）

> 时间：2026-07-27 · 主驾：Kimi · 范围：apps/control-center 配置中心 + teams schema
> 触发：LO「配置中心请你迁移 cc-switch 的配置方式并且添加团队配置的拓展」

## 一、取经（读了什么）

直接读 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 源码 `src-tauri/src/provider.rs`：核心是 **UniversalProvider**——baseUrl+apiKey 一处录入，按 app 勾选投影成各 CLI 的 live 配置（`to_claude_provider` 生成 ANTHROPIC_* env 块、`to_codex_provider` 生成 auth.json+config.toml 且纯 origin 补 /v1、SSOT 不写供应商副本）。照搬其投影规则，514cc 化四处差异见下。

## 二、处置

| # | 项 | 处置 | 落点 |
|---|----|------|------|
| ① | 存储 | ProviderStore：`dataRoot/providers.json`（0600 原子写 + 串行队列防乱序），CRUD + current 指针 per app | src/providers.mjs |
| ② | 三 CLI 投影 | claude→settings.json env 合并（无关键不动、无 Key 不动 AUTH_TOKEN）；codex→auth.json 合并 + config.toml 标记块外科手术（重复切换不叠块、用户 section 全保留）；gemini→.env 标记块 | 同上 |
| ③ | 514cc 差异 | **Key 永不出服务端**（掩码+hasApiKey，update 留空=保留）；**切换必留时间戳备份**；**live 回读按 baseUrl 认亲**（外部手改照实显示）；**坏 live JSON 拒写不 clobber** | 同上 |
| ④ | 路由 | GET/POST/PUT/DELETE `/api/providers*` + `/switch` + `/apply-team`（literal 先于 :id 匹配） | server.mjs |
| ⑤ | **团队扩展** | teams schema 加 `providers:{claude,codex,gemini}`（键白名单严格）；团队对话框「供应商绑定」三下拉（含失效绑定示形）；配置中心「团队方案」条一键应用、部分失败逐项如实回报 | teams.mjs + 前端 |
| ⑥ | 前端面板 | 三应用列（live 行+档案卡：当前/live 认亲双徽标、Key 掩码）+ 新增/编辑对话框（应用勾选联动模型区）+ 视图每次进入全量刷新（修陈旧绑定 bug）+ 品牌点 CSSOM | index.html/app.js/styles.css |
| ⑦ | 测试除旧患 | http-e2e pulse Windows 瞬时锁（EBUSY 读 pid）按未就绪重试——「偶发自复」flake 在并行压力下变 4/4 必现，修后两轮全量 0 fail | tests/http-e2e.test.mjs |

## 三、验证

- `npm test` 494 / 493 pass / 0 fail / 1 skipped（基线 481 + 13 新用例，两轮连续）；`npm run validate` 12 面 valid。
- 探针 `probe-providers.mjs` 全流程：建档（Key 掩码 `••••1234`）→ 确认切换 → current 徽标+live 行 → 团队绑定下拉（含失效态代码路径）→ 一键应用 toast「方案已应用（2 个应用）」→ 页面 0 错误。
- 磁盘实证（隔离 runtime home）：settings.json env 六键投影、config.toml 顶层三键+标记块+/v1 补全、auth.json、两次切换两枚时间戳备份。
- 截图：`.scratch/desktop-launch/40-46 provider 系列`。
- 安全纪律：全程探针走 `CONTROL_CENTER_RUNTIME_HOME` 隔离目录，**未碰真实 `~/.claude` 等 live 配置**；桌面端已重启加载新内核。

__DELTA__: Kimi | 1 | 证据：cc-qa-runtime/.codex/config.toml 标记块投影 + 两轮全量 0 fail（pulse EBUSY 旧患根治）+ 46-team-applied.png（CHANGELOG v4.0 未发布节）
