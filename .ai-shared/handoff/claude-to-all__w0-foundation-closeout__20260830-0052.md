# W0 地基波完工报告（2026-08-30）

> 触发：LO 提供远程仓库 `git@github.com:lanniny/514-bot.git`，要求按 v44 蓝图持续完善。
> 范围：W0 地基波 + 两条 P0 即刻项（F-003 密钥治理、F-004 提交前闸门）。
> 本轮**未推送**。推送属外部动作，需 LO 授权。

---

## 零、先说最重要的一件事

**`lanniny/514-bot` 是 GitHub 公开仓库（`private=false`）。**

远程历史中存在 **1 个真实凭证**：CC-Switch 本地代理 token（`tEP1_` 前缀，监听 `127.0.0.1:15721`），
位于 `.ai-shared/control-center-preview/data/ccswitch-proxy.json`，自 2026-08-18 起暴露已 11 天。

**必须视为已泄露并立即轮换。** 公开仓库会被自动爬虫扫描，通常几分钟内即被捕获。

好消息：工作树里那 10+ 个 `sk-` 云 API key **一个都没进远程历史**——但那是 `.gitignore` 挡住的运气，
不是机制保障。本轮已补上机制（F-004）。

---

## 一、致命问题

| # | 问题 | 状态 |
|---|------|------|
| F-003a | 公开仓库历史含真实代理 token | **待 LO 轮换**（我无法代为操作） |
| F-003b | 10+ 个真实 `sk-` API key 仅靠 `.gitignore` 挡住，无提交前闸门 | ✅ 已关闭（F-004） |
| F-004 | `.git/hooks/` 全空，无任何提交前检查 | ✅ 已关闭 |

---

## 二、建议改进（本轮已落地）

### 2.1 Git 证据链接回（原 R1，最高优先级）

**根因与预判不同，必须记录：**

上一轮判断「远程证据链断裂」是**错的**。`context.md` 第 116 行「快照 `2b1892c` 已推送 origin/main」是**准确的**。

真实故障：**本地 `.git` 被重新 `init` 过**——历史压成单提交 `603056d`、未配 remote、
并把 1491 个运行时产物误纳入追踪。远程 `origin/main` 历史完好，20 个提交，`2b1892c` 确在其中。

**教训**：看到「本地无 remote + 单提交」不等于「远程不存在」。先 `git ls-remote` 再下结论。

**处置**（备份先行：`I:/514claude/_git-backup/514cc-git-20260829-2339`，65MB）：

```
git remote add origin git@github.com:lanniny/514-bot.git
git reset --mixed 6bb3691        # 工作树不动，索引与 HEAD 接回远程
# 移除应忽略但已追踪的 1491 个路径
git ls-files -c -i --exclude-standard -z | git update-index --force-remove -z --stdin
git commit  →  bcf4347
git add -A  →  254a973
```

### 2.2 版本库清理

- tracked：2910（脏）→ **963**（净），移除 1491 个运行时产物
- 清理面：`.scratch/`（366MB / 1802 文件的第三方源码副本与 QA 数据）、`.qa-output/`、
  `.repro-*`、`debug-provider-*`、根级临时截图、含凭证的运行时副本
- `.gitignore` 收紧：`.scratch` 与 `.qa-output` 整体排除、含凭证文件点名排除、二进制与临时项补漏
- **磁盘文件全部保留**，只移出版本库

### 2.3 提交前密钥闸门（F-004）

`.githooks/pre-commit`（入库，用 `core.hooksPath` 挂载）：

- 只扫本次新增行（`-U0`），不误判既有代码
- 高置信度模式：`sk-` / `ghp_` / `gho_` / `github_pat_` / `xox*` / `AIza` / `AKIA` / `tEP1_` / `PRIVATE KEY`
- 排除官方占位符（`AKIAIOSFODNN7EXAMPLE`、`YOUR_GITHUB_PAT_HERE`、`sk-codex` 等）
- 命中时**脱敏输出**（仅前缀 + 长度），完整值不落终端与日志
- 支持 `# gitleaks:allow` 行内豁免

**已验证**：真实形态密钥被拦截 ✅；占位符不误报 ✅。

⚠️ `core.hooksPath = .githooks` 是**本地配置**，需每台机器执行一次。新环境 clone 后不执行 = 闸门不存在。

### 2.4 context.md 收口（原 R3）

- 更正 Git 证据链判断（含证伪说明，防止后人再踩）
- 补齐 2026-08-19~29 波次：45 份 handoff 的主题归纳（**未逐份精读**，只记主题与坐标，细节以原文为准）
- 新增三条 P0 风险；修正 `tracked=379` 的过期口径（当时范围，当前 963）

---

## 三、可保留

- `npm run validate` **全绿**，无 errors / warnings；CC-Switch 288 命令账本核对一致
- `2b1892c` 及其历史**完整保留**，bisect / blame 能力恢复
- 分两笔提交（清理 / 产品变更），历史可读，便于日后定位
- `.gitattributes` 锁定 `.githooks/*` 为 LF（CRLF 会破坏 shebang 导致钩子**静默失效**）

---

## 四、总评与下一步

W0 地基波**完成度约 90%**：证据链、清理、密钥闸门、记忆收口均已落地，`validate` 全绿。
剩余 10% 卡在两处需要 LO 决策/操作的外部事项上。

### 需要 LO 处理（我无法代办）

1. **🔴 立即轮换 CC-Switch 代理 token**（`tEP1_` 前缀）— 已在公开仓库暴露 11 天
2. **授权推送**：本地领先远程 7 笔、落后 0 笔，可 fast-forward。但——
   - SSH 被 `198.18.1.195`（代理 fake-ip）拦截
   - HTTPS 无已存凭据；`gh` 未安装，PortableGit 无 `connect.exe`
   - 需你手动推送，或提供 token / 配置代理

### v44 蓝图中仍然欠账的 P0（不依赖地基波，建议接着做）

- **F-044**：`remote-projects` / ssh / webhook 目标地址**无白名单** → SSRF 风险
- **F-046**：workspace-explorer 与附件下载**未做路径穿越审计**
- **R4 版本真源悬置**：`rules.md` 仍 v3.5.0，实际已落地 v4.0 波 / v42 闭包 / v43 重塑（纯决策，拍板即可关）

### 可选：历史净化

若要彻底清除公开历史中的 token 对象，需 `git filter-repo` 重写 + 强制推送。
**这会改写公开历史**，影响任何已 clone/fork 的人，须 LO 明确授权后再做。
注意：即便重写历史，已泄露的 token 仍必须轮换——**轮换是唯一真正的解药**。

---

## 附：本轮提交

```
a2382b3 docs(governance): 标记 F-004 已关闭并补启用说明
fbc4db4 chore(repo): 重新纳入 .githooks/pre-commit
46e5dca chore(repo): .gitattributes 锁定脚本 LF 行尾 + 补记 08-30 接续轮
8d42689 feat(guardrails): 提交前密钥拦截钩子（F-004）
2193abf docs(governance): 收口 context.md 至 2026-08-30
254a973 feat(control-center): 2026-08-19~29 bot 产品面与协作运行时收口
bcf4347 chore(repo): drop runtime artifacts and credential-bearing files from tracking
6bb3691 docs(governance): record v42 Git delivery closure   ← 接回点（远程 main）
```

产物：

- `.ai-shared/audit/secret-scan-20260829.md` — 密钥扫描报告（值已脱敏）
- `proposals/v44-completion-blueprint.md` — 完善与拓展蓝图（127 条）
- `.githooks/pre-commit` — 提交前密钥闸门
- `.ai-shared/context.md` — 收口至 2026-08-30
