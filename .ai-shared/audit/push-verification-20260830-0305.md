# 推送核验记录 · 2026-08-30 03:05 GMT+8

## 一、结果

| 项 | 值 |
|---|---|
| 推送前远端 `main` | `6bb3691` |
| 推送后远端 `main` | `5dc6d00` |
| 推送提交数 | 8（快进，无 force） |
| 通道 | `https` remote + `http.proxy=127.0.0.1:7897`（SSH 被 fake-ip 代理挡） |
| 本地同步状态 | `ahead 0 / behind 0` |
| 工作树 | 仅 `.workbuddy/memory/2026-08-30.md` 未提交（本地记忆，不入远端） |

推送的 8 个提交：

```
5dc6d00 feat(security): F-052 凭据清单审计器 + F-053 脱敏契约健壮性修复
e284ad9 chore(memory): 补记一个红的测试（已证与 F-044 无关）
f693ed9 docs(governance): 新增 .git 对象库损毁恢复手册
1327912 docs(governance): 记录 .git 对象库损毁事故与恢复过程，更新 F-044/F-046 状态
bcb2c84 docs(governance): 收口 context/decisions 至 2026-08-30，补 45 份 handoff 与 W0 完工报告
ae748e8 feat(control-center): 2026-08-19~29 bot 产品面与协作运行时收口
85860c3 feat(security): F-044 出站守卫（SSRF 白名单），覆盖 webhook / 自建端点 / 代理探测
1876bf9 chore(repo): 移出运行时产物与含凭证文件，补 F-004 密钥拦截钩子
```

## 二、推送前闸门

### 2.1 追踪范围审计（当前树）

`node scripts/secret-audit.mjs` → **952 文件 / 0 命中**。

### 2.2 逐提交审计（覆盖"加了又删"的盲区）

当前树审计看不到中间提交里**加入后被删除**的内容。做法：每个提交 `git archive` 导出到临时目录 → 就地 `git init` + `git add -A -f` → 用 **HEAD 版** `.githooks/pre-commit` 模式库（最严格，保证 8 个提交同一标准）跑审计器。

| 提交 | 文件数 | 命中 |
|---|---|---|
| `1876bf9` | 854 | 6 |
| `85860c3` | 856 | 6 |
| `ae748e8` | 897 | 7 |
| `bcb2c84` | 948 | 7 |
| `1327912` | 950 | 7 |
| `f693ed9` | 951 | 7 |
| `e284ad9` | 951 | 7 |
| `5dc6d00` | 952 | **0** |

命中集中的原因：7 处 `tests/` 合成夹具的 `# gitleaks:allow` 豁免标注是在 `5dc6d00` 里加的，因此之前每个提交都命中同一批。逐条核对确认全部是测试夹具字面量，非真实凭据：

```
tests/adapters.test.mjs:109                 known-pattern   PEM 夹具
tests/cli-config-panel.test.mjs:13          high-entropy    38 字符 / 4.70 bits
tests/observability-sessions.test.mjs:158   high-entropy    34 字符 / 5.03 bits
tests/redaction-jsonl.test.mjs:85,87,105    known-pattern   AKIA / PEM 夹具
tests/workspace-explorer.test.mjs:241       high-entropy    50 字符 / 5.36 bits
```

**结论：推送内容无真实凭据。**

### 2.3 一次自身方法论纠错

第一轮我用逐行 diff 扫描（把 diff 的 `+` 行单独喂给 `findSecretCandidates`），得到 5 处"命中"。这是**探针写歪**：逐行扫描绕过了审计器的占位符白名单与文件排除规则，导致 `const key = ...`、`token: parsed.token` 这类普通代码被计入。改用审计器本身（整文件 + 完整规则）后归零。

教训：**复用现有判定器，不要为了"更细粒度"而重造一个判定路径**——绕过白名单的扫描器比不扫描更危险，因为它制造假阴性（误以为干净）和假阳性（淹没真信号）。

## 三、🔴 仍未解决：token 在公开历史中

推送**不解决**此事。核验结果：

| 检查 | 结果 |
|---|---|
| `git cat-file -e 5dc6d00:<ccswitch-proxy 路径>` | 不存在 → **新克隆者拿不到** ✓ |
| `git cat-file -e 6077930:<ccswitch-proxy 路径>` | **仍存在** → 明文 token 仍在公开历史中 |
| `6077930` 引入时间 | 2026-08-13 10:16 |
| 暴露时长 | **约 17 天，此刻仍可抓取** |

即 `1876bf9` 只把文件从**工作树**移除，历史对象仍在。任何 `git clone` 后 `git log --all` 都能取到明文 `tEP1_` token。

### 处理顺序（重要）

1. **先轮换** —— 在 CC-Switch 侧重新生成 token，旧 token 即刻失效。这是唯一能止损的动作，我做不了。
2. **再考虑重写历史** —— `git filter-repo --path <file> --invert-paths` 后 force push。代价：重写 `6077930` 之后所有提交的 SHA，所有协作者需重新克隆。**且必须先轮换**，因为重写期间 token 仍可被抓取。

只重写历史而不轮换 = 无效；只轮换而不重写 = 安全但历史留痕。推荐两者都做，顺序如上。

## 四、发现一个 Git 环境缺陷（记录备查）

推送后发现 `.git/refs/remotes/` 为空 —— `.git` 事故恢复时未重建远端引用。尝试修复时定位到一个可复现的异常：

**git 自己写 `refs/remotes/*` 会静默失败，并删掉整个目录。**

受控实验：

| 操作 | 结果 |
|---|---|
| shell `mkdir -p .git/refs/remotes/origin` + `printf > main` | 成功，git 立刻可见 |
| 只读命令（`for-each-ref` / `status`） | 无影响，文件保留 |
| `git update-ref refs/heads/__probe2` | 无影响，文件保留 |
| **`git update-ref refs/remotes/origin/__probe`** | **exit=0，但 `.git/refs/remotes/origin/` 整个目录消失**（连同手工写入的 `main`） |
| **`git fetch https +refs/heads/main:refs/remotes/origin/main`** | 报 `[new branch] main -> origin/main`，**但目录为空** |

已排除：无 `reference-transaction` 钩子（`.githooks/` 下只有 `pre-commit`）；权限位与 `refs/heads` 一致；`logs/refs/remotes/origin/` 目录被正常创建。

**当前绕过**：手工写 `.git/refs/remotes/origin/main` 文件，git 可见且 `ahead 0 / behind 0`。**但任何对该目录的 git 写操作（尤其是 `git fetch`）都会再次清空它**——需要时重建即可。根因未定位，已记录。

补充：既然 `git fetch` 会破坏本地 remote-tracking 引用，查远端状态请优先用 `git ls-remote`（不写盘）。
