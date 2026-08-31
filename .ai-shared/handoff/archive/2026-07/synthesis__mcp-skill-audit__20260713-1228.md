# MCP + Skill 全量审计与修复

- **date**: 2026-07-13
- **participants**: 主驾(AEMEATH/fable) + 鉴(meta-reviewer/opus 独立复核)
- **triggered_by**: LO — "验证 mcp 和 skill 是否完善正确，请你帮我完善和修复"
- **verdict**: 修复完成（2 项待 LO：github PAT / rules.md 宪法勘误）
- **health_score**: 85/100（鉴 MCP/skill/hook 聚焦子系统评分）

## 环境真相（校正认知起点）

- 实际运行环境 = **Windows MINGW64**（非 darwin），HOME=`/c/Users/16643`，无 `jq`（用 python 解析 JSON）。
- **两套 mcpServers 各自独立**：`~/.claude.json` 顶层 22 个（真正的 MCP 主战场）+ `~/.claude/settings.json` 1 个（drawio）。此前易混淆。
- 514cc 真身 = `I:/514claude/514cc`；三件套 hook 挂在全局 `settings.json` 引用绝对路径。

## 验证方法（全部亲验，非信文档自述）

`curl --noproxy` 探端点存活 / `python json` dump 全量 MCP 定义 / `find -iname` 交叉验证 skill（**避开 Glob 对 /i /c 盘符假阴性坑**）/ `py_compile` 验 hook 语法 / 备份 diff 验配置编辑外科精度。

## 健康项（鉴独立复现确认）

- 三件套 hook（route/stop/mirror-gate.py）：py_compile 全过、settings.json 挂载正确、log+state 痕迹齐全。
- Skill：514cc/skills 14 个 + .agents/skills 2 个 codex-skill，SKILL.md frontmatter 0 缺陷、零幽灵零孤儿。
- 全局符号链接（.agents/skills → ~/.claude/skills）目标全在；co-* 命令 7 个非空壳。
- MCP 密钥：exa/grok/micu/roxybrowser/see/ace 全真 key 无占位；本地脚本 grok/micu server.py 真实存在。
- 20/22 顶层 MCP 依赖齐全、会话加载正常。

## 问题与修复

| # | 问题 | 证据 | 修复 | 状态 |
|---|------|------|------|------|
| 1 | see/web-reader/web-search-prime 被 module.yaml:209 + rules v3.4 误标"幽灵已移除" | 三者在 .claude.json 且会话加载成功；route-gate.log 有 connected 痕迹 | module.yaml 平反：see→visual_analysis，补 web_read | ✅已修 |
| 2 | deepwiki 命名不符（运行时实名 mcp-deepwiki） | dump args=`npx mcp-deepwiki@latest` | module.yaml 订正 | ✅已修 |
| 3 | browserwing 死配置 | curl localhost:8080 → 404，会话从未加载 | 从 .claude.json 删除（备份在先） | ✅已修 |
| 4 | github 匿名受限 + 包废弃 + plugin 禁用（三重） | env={}，`@modelcontextprotocol/server-github` 2025-04 官方停支，settings.json:339 plugin=false | 迁官方 remote（type=http, api.githubcopilot.com/mcp/）+ PAT 占位 | ⏳待 LO PAT |
| 5 | Playwright 大小写不符（module.yaml:207 playwright） | 运行时实名大写 P | module.yaml 订正 | ✅已修（鉴补出） |
| 6 | spec-workflow：rules v3.2.0 §八称"卸载"实未兑现 | .claude.json 顶层仍在且会话活跃 | module.yaml 注释标矛盾；rules 宪法勘误待 LO | ⏳待 LO 拍板 |
| 7 | drawio(第23个MCP)未纳入 module.yaml | settings.json:355 | module.yaml 补注释 | ✅已注 |

## 鉴（meta-reviewer）独立复核

异构 opus + 独立取证（find/curl/py_compile/json）。**总判：主驾核心 4 结论方向零推翻、全部复现**；补出 5 处主驾盲区（本表 #5/#6/#7 + github plugin 双禁 + 数字链自洽核对）。方法论警示：Glob 对 Windows 盘符假阴性，必须 find 交叉验证（已记入 memory）。

## 待 LO 决策

1. **github PAT**：把 `~/.claude.json` github 的 `Bearer YOUR_GITHUB_PAT_HERE` 换真 token（https://github.com/settings/personal-access-tokens/new）+ 重启生效。
2. **rules.md v3.2.0 §八 spec-workflow"卸载"过期声明**：是否新增 v3.4.1 勘误条（改宪法属 LO 权限，未擅动）。

__DELTA__: 鉴(meta-reviewer) | 1 | governance | 核心 4 结论零推翻全复现；补出 spec-workflow rules↔磁盘矛盾 + 7-13 未落盘 + Playwright 大小写 + drawio 未纳入 + github plugin 双禁 共 5 处，健康分 85/100
__DELTA__: 主驾自评 | 1 | observability | 亲验磁盘/网络订正 see 平反等 4 处文档谎言 + 外科级修 .claude.json（备份 diff 证其余 20 server 分毫未动）；盲区被鉴补 5 处，印证"同脑同盲区"需异构复核
