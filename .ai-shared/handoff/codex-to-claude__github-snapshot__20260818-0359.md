<!-- 514cc-session-id: 01a00fb1-8675-7990-b545-9b22735b7ddb -->
# Control Center GitHub 工作快照交付

- **日期**：2026-08-18 03:59 +08:00
- **目标远端**：`git@github.com:lanniny/514-Control-Center-.git`（本机配置为 GitHub SSH 443 等价地址）
- **分支**：`main`
- **性质**：当前可复现工作快照；不是 v4.0 正式版本升格

## 提交边界

1. 显式纳入 Control Center / Desktop 的已跟踪产品变更、被真实 import/测试引用的未跟踪源码闭包、对应测试、产品路线图与本波协作 handoff。
2. 明确排除 `.scratch/**`、`apps/control-center/.qa-*/**`、临时 preview HTML、运行锁、provider 探针输出和 `__pycache__/*.pyc`。
3. `apps/control-center/.gitignore` 只新增本地浏览器 QA 与 throwaway preview 的窄忽略规则。
4. delivery manifest 改用 Git `ls-files --others --exclude-standard` 作为未跟踪交付集合，避免把已明确忽略的本地证据误报为源码漂移；保留物理文件读取用于发现已跟踪删除和路径逃逸。

## 验证证据

- delivery manifest 聚焦回归：`7 pass / 0 fail`。
- `npm run qa:delivery -- --strict`：`tracked=345 / physical=345 / strict=pass`。
- Control Center 全量测试：`1417 total / 1416 pass / 0 fail / 1 skipped`，退出码 `0`。
- `npm run validate`：13 项全部 `valid: true`，CC-Switch ledger `288` 条。
- staged diff 常见真实密钥格式扫描：OpenAI/GitHub/Google/JWT/PEM/xAI/Anthropic 命中 `0`；临时/运行态路径命中 `0`。

## 边界与风险

- 当前 `HEAD` 的历史树已包含旧 QA provider/auth fixture；至少一个值具有 `sk-...` 形状。本轮未打印该值，也未新增这类文件。远端 `main` 在推送前读回仍指向同一旧 `HEAD`，因此这是既有历史风险，不是本次快照新增风险；后续应独立做 history rewrite / credential rotation 决策，不能在当前脏工作区中顺手破坏性改史。
- 工作区仍保留未提交的 `.scratch`、`.pyc`、Cursor 生成物及 QA 证据；没有 reset/checkout/清理它们。
- 正式版本真源仍是 `rules.md` v3.5.0；本次不修改版本号、不创建 tag/release。

__DELTA__: 烛(Codex) | 1 | correctness | 证据：apps/control-center/scripts/qa-delivery-manifest.mjs 将交付清单对齐 Git ignore 语义；独立提交边界审计阻止 QA/锁/探针产物进入快照
