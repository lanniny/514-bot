# 514cc 项目长期记忆

## 环境坑：git push 与远程跟踪引用（Windows）

- 此环境里 git 对 `refs/remotes/*` 的原子写入（lock+rename）失效：`git fetch` / `git update-ref` 报成功但引用文件不落盘，`git status` 显示 `[gone]`。
- Bash（Git Bash）里 `git push` 会卡在 GCM 认证（credential.helper = helper-selector）被 SIGTERM；用 PowerShell 工具跑 `git push` 可成功推送。
- 验证 push 是否成功唯一可靠方式 = `git ls-remote origin`（看 remote 真实 HEAD），不要只看 `git status`。
- 恢复本地跟踪引用 = shell 直接 `echo <sha> > .git/refs/remotes/origin/main`，git 立即识别。

## 实例锁（B-01 残余缺口，待补）

- `apps/control-center/src/instance-lock.mjs` 的 `lockOwnerIsActive` 只查 pid 存活 + 镜像名，无 HTTP 活性证明，分不清「健康旧实例」和「真孤儿」。
- 桌面端 Rust 壳（`apps/desktop/src-tauri/src/main.rs`）只有 spawn、无「检测到健康同源实例则复用」路径。
- 这是「桌面端无法启动」类问题的根因（旧实例持锁 → 新 kernel 撞锁 INSTANCE_ACTIVE 退出）。修复方向：加 HTTP 活性证明 + 复用逻辑。

## 测试与清理

- 测试运行器 `apps/control-center/scripts/run-tests.mjs`：`node scripts/run-tests.mjs <test files>` 跑测试；`--clean-only` 清 `.test-*` 残留；自带 clean-exit gate（句柄泄漏会超时失败）。
- `.test-*` 残留来自测试 `mkdtemp` 无收尾，历史上曾积累 1772+ 个；跑测试的 clean-exit 自清 + `--clean-only` 可归零。
