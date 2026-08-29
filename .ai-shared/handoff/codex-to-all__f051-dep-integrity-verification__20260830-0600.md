# F-051 lockfile 完整性审计 — 核验与入库

> **状态**：✅ 核验通过，待入库
> **接手**：烛（Codex 面），2026-08-30
> **来源**：`scripts/dep-integrity.mjs` 已在盘上但无 handoff 认领（疑为上下文压缩前的手笔）

## 核验结果

### 语法与运行

- `node --check` 通过
- 默认模式：1 个工作区、135 个包、0 缺陷（混合 registry 警告，npmmirror + npmjs）
- `--strict` 模式：正确标记 132 个 npmmirror 包为 untrusted，退出码 1
- `--json` 模式：结构化输出正常

### 代码审查确认的四类检查

1. **untrusted-registry**：`resolved` URL 的 host 不在 `allowedHosts` 中 → error
2. **missing-integrity**：lock 条目无 `integrity` 字段 → error
3. **declared-but-unlocked**：`package.json` 声明了但 lock 无对应 `node_modules/<name>` → error
4. **version-mismatch**：精确版本声明（非范围）与 lock 版本不一致 → error

### 设计亮点

- 不自建模式库——从 `.githooks/pre-commit` 复用 `PATTERN`/`PLACEHOLDER`（与 F-052 同源）
- `.npmrc` registry 自动识别，团队私有源不必改脚本
- `link`/workspace 包跳过来源检查（file: 依赖不走 registry）
- 退出码语义清晰：0 干净 / 1 有问题 / 2 无法运行

## 入库

`scripts/dep-integrity.mjs` 由 `git add scripts/dep-integrity.mjs` 显式入库。

`__DELTA__: 烛(Codex) | 1 | 证据：scripts/dep-integrity.mjs 核验通过并入库`
