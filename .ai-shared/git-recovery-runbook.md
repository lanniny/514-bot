# .git 对象库损毁恢复手册

> 来源：2026-08-30 真实事故。见 `.workbuddy/memory/2026-08-30.md` 与
> `.ai-shared/handoff/claude-to-all__git-objectdb-loss-recovery-and-f044__20260830-0145.md`。
>
> **先读这段**：整套流程的前提是「有备份 + 有 reflog + 有远端」三样中的
> 至少两样。缺两样就别折腾了，直接从工作区重建仓库。

## 0. 预防（做一次，长期受益）

```sh
# 长会话 / 自动化环境里禁用自动 repack
git config gc.auto 0
git config maintenance.auto false

# 破坏性操作前：全量备份 .git
cp -r .git /path/to/backups/repo-git-$(date +%Y%m%d-%H%M)
```

**为什么禁用自动 gc**：repack 的顺序是
「写新 pack → 删旧 pack 与已入 pack 的松散对象 → 整理 refs」。
这个过程被 SIGTERM / OOM / 断电打断，会两头落空——旧数据已删、新数据未落盘。
`git fetch`、`git commit`、`git merge`、`git stash` 都可能触发它。

**配套纪律**：不要给可能触发 auto-gc 的 git 命令套短超时。要跑就放后台，
或者先 `gc.auto=0`。

## 1. 取证（只读，先存档再动手）

症状通常是 `fatal: not a git repository`（`.git` 目录还在但 git 不认），
或者 `bad object` / `unable to read <sha>`。

```sh
ls -a .git                      # 看缺什么
ls .git/objects/pack            # .idx 在而 .pack 不在 = 典型损毁
find .git/objects -type f | wc -l
```

**立刻存档这三样，它们是最后的地图**：

```sh
cp .git/logs/HEAD        /path/to/backups/lost-reflog.txt
cat .git/logs/refs/heads/*   # 每个分支的完整 SHA 序列 + 提交信息
cat .git/FETCH_HEAD          # 远端 SHA
cat .git/ORIG_HEAD
```

reflog 给出提交顺序和信息；`FETCH_HEAD` 给出远端 SHA。有了它们，
即使提交对象全丢，也能重建历史的内容与次序。

## 2. 合并回对象（从备份）

```sh
cp -Rn /path/to/backups/<backup>/objects/. .git/objects/
```

`-n`（no-clobber）是关键：对象是内容寻址的，覆盖没有意义，
不覆盖才不会破坏仅存的现场证据。

合并后逐个验证：

```sh
for sha in <reflog 里的每个 SHA>; do
  printf "%s %s\n" "${sha:0:7}" "$(git cat-file -t $sha 2>&1 | head -1)"
done
```

## 3. 清理现场

```sh
# 移走孤立的 .idx / multi-pack-index（其 .pack 已不在，留着只会导致报错）
mkdir -p /path/to/backups/orphan-packidx
mv .git/objects/pack/*.idx .git/objects/pack/multi-pack-index /path/to/backups/orphan-packidx/
```

## 4. 重建 refs

```sh
mkdir -p .git/refs/heads .git/refs/remotes/origin .git/refs/tags
printf '<本地最新 SHA>\n' > .git/refs/heads/main
printf '<远端 SHA>\n'     > .git/refs/remotes/origin/main
```

**坑 1**：`git update-ref` 对 `refs/remotes/*` 会**静默失败**——exit 0、
不报错、不创建目录、不落盘。用 shell 重定向直写文件。
（`refs/heads/*` 用 update-ref 正常，但既然有坑就统一用重定向。）

**坑 2**：本地 ref 指向无效对象时，`git fetch` 会报
`did not send all necessary objects`。negotiation 依赖本地 ref，
必须先把 ref 落到一个**有效** SHA 再 fetch。

## 5. 补回远端历史

```sh
# 若 SSH 被代理拦截，走 HTTPS + 本地代理
git remote add https https://github.com/<owner>/<repo>.git
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 fetch https main
```

然后按第 4 步重设 `refs/remotes/origin/main`。

## 6. 重建索引（关键：必须二次清理）

```sh
mv .git/index /path/to/backups/broken-index   # 旧索引引用了已删对象
git read-tree HEAD
```

**坑 3：`git read-tree HEAD` 会把远端仍在跟踪的运行时产物重新灌回索引。**
如果远端历史里有 `.scratch/`、构建产物、日志这类东西，这一步之后它们全部
回到暂存区，一个 `git add -A` 就全部送进仓库。必须紧接着：

```sh
git ls-files -c -i --exclude-standard -z | git update-index --force-remove -z --stdin
```

用 `git ls-files | wc -l` 对比清理前后的数字，确认回到了预期值。

## 7. 重建提交

按内容域分组提交，不要一个大包。提交信息里**写明这是重建提交**，
并列出原提交的 SHA 区间——后人翻历史时需要知道这段不是原装的。

## 8. 收尾自检

```sh
git status --short                                  # 应为空
git log --oneline -10
git rev-list --count origin/main..HEAD              # ahead
git rev-list --count HEAD..origin/main              # behind
git ls-files | wc -l                                # tracked 数是否符合预期
git fsck --connectivity-only 2>&1 | grep -v "invalid reflog entry"   # 应为空
```

`invalid reflog entry` 是历史 reflog 指向已删对象，属预期噪声，
可用 `git reflog expire --expire=now --all` 清掉（确认不再需要后再做）。

## 速查：损失边界怎么判断

| 丢的东西 | 能否恢复 | 靠什么 |
|---|---|---|
| 提交对象（commit） | 通常不能 | 只能从工作区内容重建 |
| 文件内容（blob）在工作区还在 | 能 | 工作区本身就是源 |
| 远端已有的历史 | 能 | `git fetch` |
| 备份里的松散对象 | 能 | `cp -Rn` |
| 从未提交、也未入备份的工作区改动 | 不能 | —— |
