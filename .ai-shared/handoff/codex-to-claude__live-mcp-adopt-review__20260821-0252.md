---
from: 烛
to: claude
topic: live-mcp-adopt-review
mode: standard
reviewed: 2026-08-21 03:08
codex_channel: subagent-direct (codex-agent MCP 本会话未注册；未伪造 CLI 输出)
---
<!-- 514cc-session-id: unknown -->

# Codex 评审：live MCP/Skill 导入投影账本

- **评审模式**：standard
- **评审范围**：
  - `apps/control-center/src/ccswitch/domain.mjs`（observe/adopt/restoreMaskedSecrets/stripTomlMcpTables/#materializeMcp）
  - `apps/control-center/src/ccswitch/routes.mjs`（GET domain 附 live；POST mcps/import、skills/import）
  - `apps/control-center/public/modules/ccswitch-panel.js`（空态、导入、openTab selectMcp）
  - `apps/control-center/public/app.js`（能力中心 MCP「编辑」）
  - `apps/control-center/tests/ccswitch-domain.test.mjs`（导入不改写 live / 掩码回写 / TOML 不双份）
- **评审时间**：2026-08-21 03:08
- **Codex 模型**：Cursor 烛 subagent 直审
- **总 token**：n/a

---

## 致命问题（必须改）

1. **`stripTomlMcpTables` 只认 LF，Windows CRLF 的 live TOML 去重是假绿。**
   `domain.mjs:264-267` 的表头正则是 `(?:^|\\n)\\[mcp_servers\\....\\][ \\t]*(?:\\n(?!\\[).*)*`，没有 `m` 旗标，也不吃 `\r`。CRLF 文件里 `]` 后面是 `\r`，表体一行都剥不掉；随后 `#materializeMcp`（`domain.mjs:811-816`）再写入托管块，就会留下「残表赋值 + 新 `[mcp_servers."id"]`」。
   回归 `ccswitch-domain.test.mjs:373-406` 用纯 `\n` 写 `config.toml`，断言 `[mcp_servers...]` 只出现一次——在 Windows 11 真机 Codex/Grok 配置上覆盖不到。这正是本波「TOML 不双份」要防的洞，测试现在给了相反的信心。
   修法：统一把原文 `\r\n` 收成 `\n` 再剥表，或正则改成 `\r?\n`，并加一条 CRLF fixture。

2. **同名 MCP 跨 CLI 只留第一份 config，但 `apps` 全标 true；保存会用错配置覆盖其他 live。**
   `observeLiveMcps`（`domain.mjs:687-720`）按 `PROVIDER_APPS` 顺序、以 id 为唯一键。Claude 先于 Codex（`providers.mjs:20-29`）。`adoptLiveMcps`（`domain.mjs:745-754`）把这份 config 连同所有来源 app 的勾选写进账本。
   能力中心「编辑」（`app.js:21108-21114`）→ `openTab` 导入 → `fillMcp`（`ccswitch-panel.js:507-509`）勾上所有来源 → 表单保存走 `upsertMcp`（`domain.mjs:782-784`）对每个 app 调 `#materializeMcp`。Claude 的 `npx` 配置会被写进 Codex `config.toml`，原 `uvx` 块按「去重」逻辑清掉。导入函数本身确实不写 live，但本波主路径「导入并编辑 / 保存才 materialize」会在第一次保存时跨 CLI 覆写。
   修法：按 `(id, app)` 分源保存；或导入时 `apps` 只作只读来源标记，默认不把非主源 app 设为可 materialize。

## 建议改进（值得讨论）

1. **`upsertMcp` 对 `input.apps` 里值为 false 的键也 materialize。**
   `domain.mjs:782-784` + `formApps`（`ccswitch-panel.js:176-178`）会把 `PROVIDER_SCHEME_APPS` 全部键（含未勾选）送上去。保存一枚刚导入的 Claude MCP，也会备份并重写 Codex/Gemini/Kimi 等配置：false 路径对 JSON 是 `delete document[key][id]`，对 TOML 是剥表后整文件写回（`domain.mjs:814-816`）。无关 CLI 被无谓碰盘；再叠 CRLF 问题，误伤面更大。保存应只处理「相对 existing.apps 有变化」的 app。

2. **`restoreMaskedSecrets` 只还原 `env`/`headers`，判定过宽，headers 无回归。**
   `domain.mjs:270-287`：`value.startsWith("••••")` 就会用旧值覆盖。用户若把密钥改成仍以掩码开头的新串，改动会被吞掉；args / url query 里的密钥不会进这条路径。`publicState`（`domain.mjs:385-391`）会掩 `Authorization`，但测试只断言 `ACE_API_KEY`（`ccswitch-domain.test.mjs:391-401`），`github` 的 headers 导入后未走 upsert。应：掩码判定与 `mask()` 对称（后缀四位或整段 `••••`），并补 headers 回写用例。

3. **`observeLiveMcps` 不读 `~/.claude/settings.json`，能力中心却扫了。**
   能力扫描：`capabilities.mjs:939-941`（`.claude.json` + `settings.json` + Codex TOML）。账本只读 `#mcpPath("claude")` → `~/.claude.json`（`domain.mjs:791-793`）。settings 独有的 MCP 在能力页能点「编辑」，`adoptIfMissing` 会 skip，只剩 `ccswitch-panel.js:788` 的警告。要么 observe 补 settings 源，要么能力页对非账本源禁用「编辑」。

4. **`openTab` 在 `load()` 合并飞行中会填不上刚导入的表单。**
   `ccswitch-panel.js:228-229`：已有 `loadPromise` 就返回那一次。`openTab`（`778-787`）导入成功后再 `await load()`，若面板首屏 load 仍在飞，拿到的是导入前快照，`fillMcp` 空返回，用户看到「未找到可编辑的 MCP」。应在导入后强制新一轮 fetch，或 `load({ force: true })`。

5. **Skill 导入只拷 `sources[0]`，却把所有 CLI 标成已投影。**
   `adoptLiveSkills`（`domain.mjs:911-954`）从第一个存在 `SKILL.md` 的目录整树读入（`utf8`，二进制会坏），`apps` 却来自全部来源。之后 `toggleSkill` / `syncAllLive` 会用这一份覆盖其他 CLI 的 live 目录（`#materializeSkill`：`rm` + `cp`，`domain.mjs:1023-1027`）。与 MCP 同源问题。walk 无单条 try/catch，8 MiB `fail()` 会中断整批，前面已 `rename` 到 `skillRoot` 的条目尚未 `#commit`。

6. **`validateMcpConfig` 在 observe 阶段就丢掉 live 额外字段。**
   `domain.mjs:712-714` 把 config 收成 type/command/url/cwd/args/env/headers/envPassthrough。`disabled` / timeout / 各 CLI 私有键进不了账本；第一次 materialize 会把瘦身后的对象写回 live。导入可以原样克隆，校验只决定 `importable`，保存时再提示丢字段。

7. **批量「导入已接入」无确认、GET `/mcps` 仍不掩码。**
   `ccswitch-panel.js:728` `POST` body `{}` 会导入所有 importable（含密钥进 `ccswitch-domain.json` 0600）。`routes.mjs:181-183` 的 `domain.mcps()` 不走 `summary()`/`publicState`；面板主路径用的是 GET `/api/ccswitch/domain`（已掩码），但该列表接口仍是明文。导入后密钥面扩大，列表接口应复用同一套掩码。

## 可保留（看似奇怪但合理）

1. **`adoptLiveMcps` / `adoptLiveSkills` 只 `#commit` 账本、不调 `#materialize*`。** 测试 `ccswitch-domain.test.mjs:389` 锁了 `.claude.json` 字节不变。与「导入禁止改写 live」字面契约一致。
2. **`publicLiveMcp` / `publicLiveSkill`（`domain.mjs:290-319`）从 GET live 投影里拿掉 config 本体。** 能力中心同款白名单思路，env/headers 不进浏览器。
3. **已托管 skip（`already-managed`）+ 项目级 MCP 不进全局账本。** `ccswitch-domain.test.mjs:381,388` 覆盖了 `project-only`。避免把项目作用域写进全局 live。
4. **`restoreMaskedSecrets` 在 `upsertMcp` 里、对已有 env 的 `••••` 回写。** 方向对；`ACE_API_KEY` 用例证明主路径能保住真密钥。不要改成「表单禁发 env」——那样用户连轮换密钥都做不到。
5. **`spliceManagedBlock` 先清空再 `stripTomlMcpTables` 再写托管块**（`domain.mjs:814-816`）。在 LF 文件上这是对的手术顺序；缺的是换行符归一，不是这个顺序本身。
6. **能力中心「编辑」始终带 `adoptIfMissing: true`。** 未托管则先入账再填表，符合「扫描是 live、编辑走投影账本」的分层；失败时警告而不是静默写 live。

## 总评

主路径设计是对的：live 只读观察 → 导入只写 `ccswitch-domain.json` → 掩码出站 → 保存才 materialize。空态文案、单条「导入并编辑」、能力中心跳本机表单，能让「暂无托管」变成可感知的导入动作。

不能按当前测试宣称 Windows 上 TOML 去重已闭合：去重正则与 CRLF 真机配置不对齐。再加上「一 id 一份 config + 多 CLI 勾选」，能力中心「编辑 → 保存」会把第一份配置投影到其他 CLI。这两条在本波主用户路径上是数据损坏级，不是文案问题。

建议先补 CRLF fixture 并改剥表；导入改为分源或默认只托管观察到的主源；保存只 materialize 有变化的 app。掩码回写、项目级 skip、导入不碰 live 字节可以留。

---

## 下游建议

### 建议召唤
无（先修剥表与分源，再考虑是否拉烛复检 TOML）。

### 风险信号
- TOML 去重测试只覆盖 LF，与仓库里其他「Windows CRLF 必须归一化」的契约测试（`config-topology-state.test.mjs` 等）不一致
- 能力中心与账本观察源集合不对齐（settings.json）
- 导入后勾选即等于后续 delete/sync 的 live 写权限

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | 证据：domain.mjs:264-267 stripToml 不吃 CRLF，测试 ccswitch-domain.test.mjs:373-406 只写 LF；observeLiveMcps:687-754 同名跨 CLI 一份 config + apps 全 true，保存会覆写其他 live

## 主驾回修（2026-08-21）

1. `stripTomlMcpTables` / `parseTomlMcpServers` 先把 `\r\n` 收成 `\n`；回归改 CRLF fixture。
2. 同名跨 CLI：command/url/args fingerprint 不一致则不勾选该 app；`upsertMcp` 对从未启用的 app 不再 `materialize(false)`，避免删掉别人的同名 live。
3. `Authorization` headers 掩码回写补测；observe 补 `~/.claude/settings.json`。
4. `load({ force: true })` 避免导入后填表吃到旧快照；批量导入要确认。
5. Skill 导入只托管第一个来源 CLI。

验证：`live MCP/Skill 导入进投影账本…` 单测通过（含 CRLF、跨 CLI 不同 command、headers 密钥）。node --test 收尾在本机偶发挂起，与本波断言无关。
