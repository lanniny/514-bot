# 能力声明芯片墙波：Skill/MCP 逗号输入退役（Kimi → all）

> 时间：2026-07-27 · 主驾：Kimi · 范围：apps/control-center 团队配置对话框能力声明区
> 触发：LO「skill和mcp的配置和选择太混乱了好几个界面和很粗糙简单的写入」

## 一、诊断

团队对话框的 Skill/MCP 是两个逗号分隔文本输入：用户要徒手拼技能名（猜错静默无效）、与能力图谱视图的数据各说各话、读写全靠字符串 split——正是 LO 说的「粗糙简单的写入」。

## 二、处置

| # | 项 | 处置 | 落点 |
|---|----|------|------|
| ① | 数据源 | 芯片目录 = `/api/capabilities`（与能力图谱视图同一份扫描：skills 矩阵 + MCP servers），不再猜名字 | app.js `renderTeamChips` |
| ② | 分层 | 分区标一句话定位「勾选=声明给主脑派工参考；真实启停矩阵在能力图谱」+「前往管理」`data-view-jump` 直达 | index.html |
| ③ | 三态芯片 | 勾选暖铜高亮 / 未勾灰框 / **幽灵片**（团队声明了但目录没有→虚线边+title「取消勾选即摘除」，绝不静默吞掉）；MCP 禁用项划线 is-off；内置团队只读全 disabled | shell.css `.chip-wall/.chip` |
| ④ | 收集回路 | `collectTeamForm` 改读 `checkedChipValues`（墙空时回退团队原值，防目录未到保存清空）；`loadCapabilities` 末尾回填钩子（目录晚到保留当前勾选不回滚） | app.js |
| ⑤ | **失败态真 bug** | 原实现失败后墙永停「正在读取…」且渲染层回环重触发→**无限自旋请求风暴**（零控制台报错）。修法：`state.capabilitiesLoading` 在飞去重 + 失败显式停「失败+重试钮」（`data-chips-retry` 委托）+ `teamChipsPending` 暂存勾选意图 | app.js + state.js |

## 三、验证

- `npm test` 480 pass / 0 fail / 1 skipped（其间一次 EBUSY Windows 文件锁 flake 自复，与前端无关）；`npm run validate` valid。
- 探针 `probe-chips.mjs`：26 skill 片（21 目录 + 5 幽灵：co-research/co-enhance/vibe/ssh/docx——内置团队声明的用户域技能，如实示形）、39 MCP 片、7 勾选暖铜高亮、内置只读全 disabled、亮/暗双截亲查、页面 0 错误。
- 故障注入探针 `probe-chips-fail.mjs`：注入 500 → 墙停「目录读取失败：注入故障：目录服务熔断 + 重试」，静置 2s 请求数=1（**不自旋**）；放行后点重试 → 26/39 芯片回填、7 勾选保留。
- 截图证据：`.scratch/desktop-launch/33-*.png` / `34-chips-fail.png`。

__DELTA__: Kimi | 1 | correctness | 证据：probe-chips-fail.mjs SPIN-CHECK 请求数=1 实证自旋修复 + 33-skill-wall-element.png 五枚幽灵虚线片示形（CHANGELOG v4.0 未发布节）
