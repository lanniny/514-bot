# 任务卡：治理文档双地落修复的内容忠实性评审

- **from**: 主驾(Claude) → **to**: 烛(Codex)
- **date**: 2026-07-16 00:35
- **评审模式**: 文档忠实性 / 信息完整性（**非代码逻辑**）
- **工作目录**: `I:/514claude/514cc`

---

## 一、背景（触发）

发现 `rules.md` 双地落倒挂：运行时 `~/.ai-collab/rules.md` 有 v3.4.1 条目，仓库源 `I:/514claude/514cc/rules.md` 却没有——v3.4.1（2026-07-13 的 MCP/skill 审计勘误）当时只写进了运行时，忘了回写仓库源 + CHANGELOG。而 `sync-runtime.ps1` 是「源→运行时单向覆盖」，下一次 `-Apply` 会用旧源抹掉运行时的 v3.4.1（数据丢失陷阱）。本轮补齐仓库源并已跑 `-Apply` 使两边一致（107=107 行）。

## 二、本轮改动（4 处，均已落盘，请逐一核对真实文件）

1. **`CHANGELOG.md`** 第 10–27 行 — 新增 v3.4.1 完整条目（插在 v3.4.0 之前，日期 2026-07-13）
2. **`rules.md`** §八（第 97–107 行）— 回写 v3.4.1 摘要（第 101 行）+ 把 v3.3.0~v1 的膨胀长条压成「聚合一行 + 顶部指针到 CHANGELOG」（第 99 行指针，第 103–107 行压缩行）
3. **`CLAUDE.md`** 版本段（第 85–96 行）— 补 v3.4.1（第 89 行）+ 精简为一致风格
4. 已跑 `sync-runtime.ps1 -Apply`，源↔运行时 `rules.md` 已一致

## 三、权威事实源（请据此核对，勿凭训练知识）

- **`.ai-shared/decisions.md`** 第 1157–1195 行：`D-2026-07-13-001 · MCP + Skill 全量审计与修复`（含决策/验证/边界/两条 __DELTA__ + 1191 行起「rules 宪法勘误落实」段）
- **`.ai-shared/handoff/synthesis__mcp-skill-audit__20260713-1228.md`**（全文，尤其第 27–41 行的「问题与修复」7 行表 + 鉴复核段）
- **`module.yaml`** 第 3 行（version: 3.4.1）+ 第 205–221 行 mcp_servers 段（web_read/visual_analysis/browserwing/drawio/spec-workflow/Playwright/mcp-deepwiki 的磁盘真相）

## 四、评审重点（逐条给判决 + file:line 证据）

1. **忠实性**：`rules.md §八` 第 101 行 / `CHANGELOG.md` v3.4.1 条目的内容，是否忠实于 D-2026-07-13-001 + 该 handoff？三类订正项（①spec-workflow 卸载未兑现现役 ②see/web-reader/web-search-prime 平反 ③运行时层 browserwing/github/module.yaml）有无捏造、夸大、或漏关键订正项？「鉴异构复核 85/100」是否有源？
2. **信息无损**：`rules.md §八` 把 v3.3.0~v3.1.x/v3.0/v1-v2 长条压成一行（第 103–107 行），被压缩掉的内容是否确实都在 `CHANGELOG.md` 完整保留（CHANGELOG 现覆盖 v3.4.1→v1.7.0 及更早，请抽查确认无静默丢失）？顶部指针（第 99 行）是否真能把读者导到完整史？
3. **一致性**：三处（`rules §八` / `CHANGELOG` / `CLAUDE.md`）v3.4.1 描述是否互相一致、与 `module.yaml` 磁盘真相一致？我在 v3.2.0 历史摘要里加了「（后经 v3.4.1 勘误：卸载未兑现，现役）」前向指针（rules 第 104 行 / CLAUDE 第 92 行），是否合理（是加勘误指针，不算篡改历史条目本身）？另请特别核对：`rules §八` 尾行写「v1.0–v2.0.1」而 `CLAUDE.md` 尾行写「v1.0–v2.0.0」——是否为不一致缺陷？
4. **格式/断链**：markdown 结构（标题层级/列表/加粗）、指针引用（`CHANGELOG.md` / `D-2026-07-13-001` 编号 / handoff 文件名 `synthesis__mcp-skill-audit__20260713-1228.md`）是否有效、无断链、文件名拼写与磁盘一致？
5. **我没想到的任何盲区**（例如：日期正确性、drawio「补注释」与 module.yaml「本表未纳入」措辞是否自洽、handoff 里「待 LO：github PAT / rules 勘误」两项与本轮是否闭合等）。

## 五、产物格式（严格遵守）

四节结构，简体中文：

```
## 致命问题（必须改）
## 建议改进（值得讨论）
## 可保留（看似奇怪但合理）
## 总评
```

每条给 `file:line` 证据。若某节为空，写「无」。

末尾附一行（另起一行，顶格）：

```
__VERDICT__: APPROVED | CHANGES_REQUESTED | REJECTED_FUNDAMENTAL
__DELTA__: 治理文档双地落修复 | {0=无新发现 / 1=补强主驾 / 2=推翻主驾判断} | {证据：致命#X 或 file:line}
```

**对抗式底线**：这是 dogfood 自评，主驾自己写的治理文档最可能有「同脑同盲区」。0 发现要给出你真扫过的证据，不许礼貌性放行。
