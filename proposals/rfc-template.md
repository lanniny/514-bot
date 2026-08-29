# RFC: rules.md 变更提案模板

> **用途**：任何对 `rules.md`（宪法）的修改必须通过此 RFC 流程
> **版本**：v1.0

## 基本信息

- **RFC 编号**：RFC-NNN（按提交顺序递增）
- **标题**：简明描述变更内容
- **作者**：@author
- **日期**：YYYY-MM-DD
- **状态**：draft / under-review / approved / rejected / implemented

## 动机

为什么需要修改 rules.md？当前存在什么问题或机会？

## 变更内容

### 方案 A（推荐）

详细描述推荐的变更方案，包括：
- 具体修改哪些章节/段落
- 新增/删除/修改的规则文本
- 影响面分析

### 方案 B（备选，如有）

如果有替代方案，在此描述并说明权衡。

## 影响面

- **受影响的 agent**：列出所有可能受此变更影响的 agent 角色
- **受影响的 workflow**：列出可能受影响的协作流程
- **向后兼容性**：是否破坏现有行为？是否需要迁移？

## 评审要求

- [ ] 烛（Codex reviewer）已审查
- [ ] LO 最终批准
- [ ] 冷却期已过（24 小时，紧急修复可跳过）

## 回滚方案

如果变更后发现问题，如何快速回滚？

## 实施记录

- **批准日期**：YYYY-MM-DD
- **实施者**：@implementer
- **实施 commit**：[commit hash](link)

---

**注意**：提交包含 rules.md 变更的 commit 前，必须在 `proposals/` 目录下有对应的 RFC 文件，且文件名格式为 `rfc-NNN-rules-change.md`。
