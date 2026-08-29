<!-- 514cc-session-id: a15f882e-8bb5-45d0-8ca7-e7944aae991b -->
# 供应商配置界面 live 热加载（Grok Build 线续接）

日期：2026-08-14
执行者：主驾（Claude / 洛琪希皮肤）· 未召唤外部 subagent（会话级 harness 指令禁止未经 LO 请求的 AgentTool）
状态：`IMPLEMENTED / 待 LO 验收`。未 commit、未 push。

## LO 报的现象

`~/.grok/config.toml` 生效档位已是 `grok-4.6`，Console 供应商编辑框仍显示 `grok-4.5`（截图 `J:\PixPin_2026-08-14_06-55-46.png`：客户端模型档位与默认模型两处都是 4.5）。

## 根因（两层，第二层比报的现象更重）

1. **显示层**：`providers.json` 档案是"下次启用写什么"的期望态，界面只读档案，从不显示 live 回读值。`liveStatus()` 虽然读 `~/.grok/config.toml`，但结果只用于"认亲 + 端点行"，模型档位从不出现在行上或对话框里。且 grokbuild 分支用 `^\s*model\s*=` 取"文件里第一个 model="——多张 `[model."x"]` 表时会认错档位。
2. **写入层（新发现，独立于 LO 的报障）**：`#applyGrokBuild` 走 `spliceManagedBlock`，它只摘旧的 514 管理块，**块外已有的 `[models]` / `[model."x"]` 表原样保留**。LO 当前文件正是这种形态（无 marker，是 CLI/手改写的）。因此点"启用"会产出**两份 `[models]`**——TOML 规范里是重复表定义（非法），或让块外旧表遮盖新投影。表现为"点了启用也不生效"。
   - 复现证据：以 LO 现场形态跑 splice，`[models]` 出现 2 次。
   - 反例闸：`tests/providers.test.mjs` "applyGrokBuild：块外已有 models/model 表时启用不产出重复表定义"。**红检已做**——摘掉修复后该闸 + liveStatus 闸双双变红（77 → pass 75 / fail 2），不是假基线。

## 改动

### 后端 `src/providers.mjs`
- 新增 `tomlTableBody(text, header)`：TOML 表体切片（顺手把 kimi managed 表的重复内联实现 DRY 掉）。
- 新增导出 `parseGrokLiveConfig(toml)`：按 `[models].default` 指向的 `[model."<档位>"]` 表回读 profile / model / baseUrl / name / apiBackend / contextWindow。`default` 缺席时退回第一张 `[model."x"]` 表；空文档与 null 安全。
- 新增导出 `providerLiveDrift(app, provider, liveInfo)` + 内部 `PROVIDER_LIVE_DRIFT_FIELDS` 谱（覆盖 8 个 app）：逐字段比对 live 与档案。**live 侧读不到（null/空）的字段一律跳过**——凭"读不到"报漂移会变成狼来了；baseUrl 尾斜杠差异不算漂移；`official` 态不比对。
  - grokbuild 的 `profile` stored 回落链刻意与对话框一致（`profile → models.grokbuild.model → providerKeyOf`），否则"改回档案值"会写一个界面从未显示过的值。
- 新增导出 `stripGrokModelTables(text)`：只摘 `[models]` / `[model.*]` 命名空间，`features`/`plugins`/`compat.*`/`ui`/`marketplace` 等 LO 自有表一律保留；`[modelsomething]` 这类同前缀不同命名空间不误伤。
- `#applyGrokBuild`：改为 `摘旧管理块 → stripGrokModelTables → 写新块`。
- `liveStatus()`：grokbuild 分支改用 `parseGrokLiveConfig`，新增 `profile/apiBackend/contextWindow` 上报；收尾对 8 个 app 统一挂 `drift`（认亲成功才算漂移，未认亲挂空数组保证前端可无条件按数组消费）。

### 后端 `server.mjs`
- 新增 `GET /api/providers/live` → 只回 `{ live }`，不带档案列表（轮询专用轻端点，literal 路由排在 `:id` 之前）。

### 前端
- `api.js`：`providerLive` 端点。
- `state.js`：`providerDialogLiveDrift`。
- `app.js`：
  - `PROVIDER_LIVE_FIELD_INPUTS`（live 字段 → 对话框控件 id）+ `providerLiveDriftOf()`（滤掉没有对应控件的字段——不报用户改不到的漂移）。
  - `fillProviderDialog`：认亲档案按 live 值预填，**排在配置预览干跑之前**（预览显示的才是"保存后会写入什么"）。
  - `applyProviderLiveDriftValues` / `renderProviderLiveDriftNotice`：通知条逐字段列出 `live X / 档案 Y` + 双向一键切换（改回档案值 ⇄ 采用 live 值），只改表单不落盘。值经 `escapeHtml`——`config.toml` 是外部可写文件，不当可信 HTML。
  - 供应商行新增 `live N 项不同` 徽标（title 列逐字段全文）；live 行补上 live 模型与不一致计数。
    - 文案由 LO 2026-08-14 拍板：初版写的是 `live≠档案 N`，LO 一眼没读懂（原话"什么叫live不等于档案2"）→ 换成自解释短句，"live" 沿用上方 live 行既有语汇保持同页统一。已加文案闸（`provider-live-hot-reload.test.mjs` 第 9 test：禁 `≠`/`!=`/`<>`、必含 `live ${drift.length} 项不同`、title 必留逐字段全文），**红检过**（改回 `≠` 写法立刻变红 8/9）。
  - live 轮询（8s）：仅在 `view=config && surface=providers && !configHostId && !hidden` 时开；内容未变不重画（不每 8 秒销毁一次焦点）；`visibilitychange`/`focus` 立即补一次；轮询失败静默重试不弹 toast。
- `index.html` / `styles.css`：通知条容器与样式（含暗色 token 复用与 `is-live-drift` 徽标）。

## 设计取舍（明确不做静默）

档案与 live 允许不同（编辑档案不自动投影）。所以既不"以档案为准"（会骗人说在跑 4.5），也不"静默采用 live"（会悄悄改掉 LO 存的意图）。取的是：**live 认亲的档案按 live 预填 + 差异逐条摆出来 + 一键还原**。

## 验证

- `parseGrokLiveConfig` 对 **LO 真实 `~/.grok/config.toml`** 只读回读：`profile/model = grok-4.6`、`baseUrl = https://514claude.xyz/v1`、`apiBackend = responses`、`contextWindow = 500000`；`official = false`；回读结果不含密钥。
- 对 **LO 真实 `providers.json`** 档案 `provider-99193a73` 比对，漂移正是两条：客户端模型档位 `live grok-4.6 / 档案 grok-4.5`、默认模型 `live grok-4.6 / 档案 grok-4.5`。
- 隔离实例真 HTTP：`GET /api/providers/live` → 200，`model/profile = grok-4.6`，认亲命中，drift 2 条，响应无密钥，`/api/test/shutdown` 202 优雅退出。
- **真浏览器验收**（Playwright，1440×1000，隔离 HOME/data 复刻 LO 现场）：
  - live 行：`live：https://514claude.xyz/v1 · 模型 grok-4.6（与档案有 2 项不一致）`
  - 行徽标 title：两条漂移全文
  - 对话框实测取值：客户端模型档位 `grok-4.6`、默认模型 `grok-4.6`、Backend `responses`、上下文 `500000`
  - 通知条：`已按运行中的 live 配置填充 2 个字段`，点"改回档案值"后两字段回到 `grok-4.5`、按钮翻转为"采用 live 值"
  - **热加载确证**：先在浏览器里存下基线文本，再改磁盘 `config.toml`（`grok-9.9-second-probe` / `chat_completions` / `131072`），**页面不刷新**（`navigation.type = navigate`，无 reload），live 行自行变为该值、漂移涨到 4 项。
  - 控制台 7 个 501 全部来自 `CONTROL_CENTER_TEST_MODE` 关掉的 channels/office/market/ssh，与本改动无关。
- 测试：新增 `tests/provider-live-hot-reload.test.mjs`（9 tests，含 LO 拍板后补的文案闸）+ `tests/providers.test.mjs` 新增 4 test（含红检过的两条反例闸）；`tests/config-topology-state.test.mjs` 两处注入切片补 `reconcileProviderLivePoll: noop` stub。
- 回归：供应商相关 15 文件 **232/232 pass**；全量 `npm test` **1102 tests / 1101 pass / 0 fail / 1 skip，真实 EXIT=0**（本轮未撞既有的 TAP 汇总后不退出问题）；`npm run validate` 13/13 valid, EXIT=0；`node --check` 全过。

## 留给 LO 的判断（我没有擅自动的）

1. **建议召唤烛复审**：本轮改了 `#applyGrokBuild` 这条**会重写 `~/.grok/config.toml` 的写路径**（新增"摘除块外 models/model 表"语义）。按 §三 这属 🔴 面，但本会话 harness 指令禁止未经 LO 请求就起 subagent，所以我只做了自评 + 红检。要发火请说一声。
2. **既有的 profile 回落不一致（我只对齐了显示，没改写入语义）**：对话框"客户端模型档位"的回落是 `profile → models.grokbuild.model`；而 `#applyGrokBuild:2899` 的回落是 `config.profile || providerKeyOf(provider,"grokbuild")`。LO 真实档案没存 `profile`，所以现在点"启用"写出的表名会是名称派生的 `https-514claude.xyz`，而不是界面显示的 `grok-4.5/4.6`。改写入侧回落是独立决策（会改变既有未保存档案的 TOML 表名），等 LO 拍板。规避办法：在对话框里保存一次，`profile` 就落档案了。
3. **live 预填的采纳面**：目前只有 grokbuild 有完整 live 明细（档位/模型/backend/上下文）。其余 app 的 drift 谱只覆盖 model/baseUrl，机制通用但明细不如 grok 全；codex 的 live `model` 正则仍是"第一个 match"的老读法，没顺手改（不在本轮 scope，要改说一声）。
4. 未 commit / 未 push。`.tmp/` 下的一次性验证脚本与隔离运行目录已全部清除，无伪造密钥残留。

__DELTA__: 主驾自评(无外部发火) | 1 | correctness | 证据：apps/control-center/src/providers.mjs:2899-3050 摘除块外 models/model 表，修掉"启用产出重复 [models] 表 / 旧表遮盖新投影"；红检确认反例闸 buggy 必变红（pass 75 / fail 2）
