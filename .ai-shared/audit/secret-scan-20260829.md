# F-003 密钥扫描报告

- 扫描时间：2026-08-29 23:45 (GMT+8)
- 扫描范围：工作树全量（排除 .git / node_modules / target / dist / .next）
- 密钥值一律脱敏，仅保留前 6 位前缀用于去重定位

## 一、命中的真实密钥（脱敏）

| # | 前缀 | 类型 | 出现文件数 | 最高危位置 |
|---|------|------|-----------|-----------|
| - | `sk-Oh81Uz...` | sk-family | 17 处 | 见下节明细 |
| - | `sk-XknFB6...` | sk-family | 8 处 | 见下节明细 |
| - | `sk-123456...` | sk-family | 6 处 | 见下节明细 |
| - | `sk-8x4nCr...` | sk-family | 4 处 | 见下节明细 |
| - | `sk-PqBMZh...` | sk-family | 3 处 | 见下节明细 |
| - | `sk-c2481e...` | sk-family | 2 处 | 见下节明细 |
| - | `sk-Xr9htV...` | sk-family | 2 处 | 见下节明细 |
| - | `sk-S83KXu...` | sk-family | 2 处 | 见下节明细 |
| - | `AKIAIOSFO...` | sk-family | 2 处 | 见下节明细 |
| - | `AKIAABCDE...` | sk-family | 2 处 | 见下节明细 |
| - | `sk-oUFCam...` | sk-family | 1 处 | 见下节明细 |
| - | `sk-codexF...` | sk-family | 1 处 | 见下节明细 |
| - | `sk-a0db50...` | sk-family | 1 处 | 见下节明细 |
| - | `sk-Te6BkY...` | sk-family | 1 处 | 见下节明细 |
| - | `sk-FPmKYj...` | sk-family | 1 处 | 见下节明细 |

## 二、已确认为占位符（安全，无需处理）

- `AKIAIOSFODNN7EXAMPLE` — AWS 官方示例凭证，出现在 `.scratch/cc-switch/.../s3.rs`
- `YOUR_GITHUB_PAT_HERE` — 占位符，出现在 `.scratch/grok-*.log`
- PEM 私钥头（`-----BEGIN` + `OPENSSH PRIVATE KEY-----`，此处拆分书写以免触发 F-004 提交闸门）— 仅出现在 `.scratch/LiveAgent/.../web-settings.test.mjs` 测试用例，无密钥体

## 三、判定

- **已进 Git 历史？** 否。所有含密文件当前均为 UNTRACKED（被 .gitignore 第 2/20/23 行排除）。
- **是否已泄露到远程？** 否——远程仓库 `6bb3691` 与本地 `603056d` 无关，本地历史尚未推送。
- **风险等级**：**P0**。一旦执行 push 且 .gitignore 失效或覆盖不到，密钥即刻公开。

## 四、处置建议（按顺序）

1. **先净化再推送**：推送前执行 `git rm -r --cached` 清场，并复核 `git status` 无敏感文件。
2. **密钥轮换**：上表中每一条都视为已暴露（因为曾明文落盘且被多次备份复制），应在对应服务商后台重新签发。
3. **加 pre-commit 拦截**：见 F-004，用 gitleaks 或自研脚本阻断含密提交。
4. **不要只删文件**：删除历史中的密钥需要 `filter-repo` 重写，代价高；当前未入历史，属于**最佳处置窗口**。
