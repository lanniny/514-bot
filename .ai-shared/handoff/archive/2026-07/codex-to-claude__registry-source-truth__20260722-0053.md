---
from: codex
to: claude
topic: registry-source-truth
date: 2026-07-22
status: complete
---

# 注册表与仓库真值收敛

## 范围

- 正式 framework version 收敛到 `3.5.0`，并明确 v3.6/v3.7 只是未发布功能波次。
- `module.yaml` 登记磁盘上的 21 个 skill（14 Claude + 7 Codex）和 8 个 Console adapter。
- 新增 `schemas/module.schema.json`、`requirements-validation.txt`、纯数据 adapter manifest 与仓库集合差/接线/版本一致性校验。
- 清理 `.ai-shared/context.md` 中“非 git、待重启、固定测试总数”等过时快照。
- `.ai-shared/decisions.md` 仅追加重复 ID 纠错映射，未改写历史标题。

## 机械约束

`npm run validate` 现在同时验证：

1. 四份 Console JSON contract。
2. `module.yaml` 的 YAML + Draft 2020-12 schema。
3. `module.yaml skills[].path` 与 `skills/**/SKILL.md`、`.agents/skills/**/SKILL.md` 的集合差。
4. `control_center.adapters`、adapter 实现文件和 `src/adapters/manifest.mjs` 的集合差；`index.mjs` 的接线只通过隔离的 `vm.SourceTextModule` 解析静态依赖，注释、字符串和模板 decoy 不参与真值。
5. `models.json` profile id、adapter id、fallback 与 manifest 的接线一致性；拒绝重复 profile/factory、adapter 错配和幽灵绑定。
6. `adapters/index.mjs` 从同一 manifest 创建实例，并在运行时断言 `instance.id === binding.adapterId`。
7. `rules.md` / `CHANGELOG.md` / module / Claude / Codex / README / plugin 正式版本入口一致性。
8. Markdown 只读取可见结构，忽略 HTML 注释、代码围栏与引用，同时对重复版本节、重复正式版本行和重复 CHANGELOG release heading fail-closed。
9. runtime contracts 与配置引用的存在性和边界。
10. Claude/Codex Stop hook 的注册事件、共享 handoff source registry 与严格 DELTA 契约。
11. 在系统临时目录创建隔离工作区，真实调用两份 stop-gate `main`，覆盖 exact/foreign/conflicting session marker 及 valid/missing/malformed DELTA。

Windows Python 子进程固定使用 `-X utf8`；缺 PyYAML/jsonschema 会显式失败，不再静默退化为仅语法检查。

validator 仅导入纯 `ADAPTER_BINDINGS` manifest，不导入或实例化生产 adapter 图；对抗夹具已证明即使 `adapters/index.mjs` 顶层抛错，仓库真值校验仍可独立执行。静态 import 解析失败、超时或返回非法结构时一律 fail-closed。

`.github/workflows/control-center-ci.yml` 的 Python cache 真源已改为仓库根 `requirements-validation.txt`；安装步骤在默认工作目录 `apps/control-center` 下使用 `../../requirements-validation.txt`，两条路径机械解析为同一文件。

## 验证

- `node --experimental-sqlite --test tests/validator-governance.test.mjs`：12/12 通过，含 manifest 独立性、删除真实 import 但保留行注释/块注释/模板 decoy 的 adapter 对抗、重复可见版本结构、真实双 hook `main` 负向用例。
- `npm run validate`：11 个结果全部 `valid: true`：4 个 Console JSON schema，以及 `core.module`、`registry.skills`、`registry.adapters`、`registry.models`、`framework.version`、`runtime.contracts`、`governance.handoff`。
- 上述两条命令于 2026-07-22 在 `apps/control-center` 当前磁盘态重新执行并返回 exit code 0。
- `node --check src/validator.mjs` 与 `node --check tests/validator-governance.test.mjs`：exit code 0。
- 治理范围 `git diff --check`：exit code 0；仅报告既有 LF/CRLF 转换提示，无 whitespace error。
- CI cache/install 两个 requirements 路径经 `Resolve-Path` 比对 `SameFile: True`。
- 本治理子任务未运行全量 `npm test`，由主线程在性能并行改动收口后统一执行，避免把其他 agent 的在途状态包装成治理线结论。
- 未执行 runtime sync，未修改 `~/.codex`、`~/.claude` 或用户运行时。

## 独立复核

- 二轮只读 reviewer 基于新磁盘态返回 `__VERDICT__: APPROVED`，确认旧 import 全文正则假绿、runtime factory 一致性、真实双 Stop hook `main` 探针和 Markdown 重复可见结构四条主风险均已闭合。
- reviewer 遵守只读约束，没有把实现线程的 `12/12` 与 11 项 validate 冒充成独立执行；其结论来自当前源码与对抗测试静态复核。
- 非阻断 P2：manifest 仍以动态 `import()` 加载纯 `.mjs`；fallback 图与缺失必需 profile 主要由启动 validator 保证。后续若允许绕过启动校验直接调用 `createAdapters()`，应把图校验抽为 validator/runtime 共用断言。

## 交接

正式发布时应先更新 `rules.md` / `CHANGELOG.md` 真源，再同步派生入口；校验器会阻止半更新状态。当前只完成仓库治理源收口，不代表用户运行时已经同步或 Console 进程已经重启。

__DELTA__: 烛(Codex) | 2 | 证据：apps/control-center/src/validator.mjs 以纯 manifest、结构化静态 import、真实双 hook main 和重复版本 fail-closed 关闭上一轮假绿面
