# 任务卡：SOUL 纳入双地落 · dogfood 治理评审

## 你的角色
你是独立代码/架构评审官（second opinion）。本次是 dogfood 治理评审——主驾（Claude Opus）自写治理代码，前两次被独立评审抓出致命盲区（stop-gate 裸 token 判 DELTA、mirror-gate 二态假绿灯）。**重点不止代码语法，更要照架构/工作流决策的盲区，尤其"看似安全实则有隐患"的。** 请独立推理，不要默认主驾判断正确。

## 背景
514cc 是一个多-agent 协作框架仓库，有一套"双地落"机制：仓库源文件 → 运行时文件（单向覆盖，源=唯一真相），由 `scripts/sync-runtime.ps1` 校验/同步，由 `.claude/hooks/mirror-gate.py`（开机 SessionStart hook）做漂移哨兵。

今天发现全局 SOUL `~/.claude/CLAUDE.md`（AEMEATH 人格核心，333 行/22943 字节，作用于该机器上**所有** Claude Code 项目）是唯一游离在 sync/漂移哨兵之外的核心文件，误改无源可恢复。本次把它纳入双地落。

## 改动（3 处，均已落盘）
1. **新建 `soul/CLAUDE.md`**：用 Copy-Item 从运行时 `~/.claude/CLAUDE.md` 逐字节复制作为仓库源。
2. **`scripts/sync-runtime.ps1`**：`$pairs` 加第 16 对 soul。
3. **`.claude/hooks/mirror-gate.py`**：`check_drift` 内联 pairs 从 2 对扩到 3 对（加 soul）。

## 已由主驾亲验的事实（你可复核，勿推翻无据）
- SHA256：源与运行时**完全一致** `75b685198d7217085a5649a8f8369b1d0d6e7e5928b2031020ef0c500a734aaf`，字节 22943==22943。逐字节复制属实。
- sync 第 42 行 soul 映射：`s = "$repo\soul\CLAUDE.md"`（源）→ `d = "$home_\.claude\CLAUDE.md"`（运行时）——方向未写反。
- mirror-gate 第 150 行 soul 对与 sync 第 42 行路径逐字一致。
- `.ai-shared/backups/` 已有历史 `claude-runtime-*` 备份目录，证明 -Apply 的备份逻辑跑过。

## 权威事实源（请自行读取全文核对，勿凭训练假设）
- `I:/514claude/514cc/scripts/sync-runtime.ps1`（88 行）
- `I:/514claude/514cc/.claude/hooks/mirror-gate.py`（264 行）
- `I:/514claude/514cc/soul/CLAUDE.md`（新建源）vs `~/.claude/CLAUDE.md`（运行时）

## 关键代码段（带行号，便于定位；请仍以文件全文为准）

### sync-runtime.ps1 —— $pairs 尾部 + 单向覆盖 + 备份逻辑
```
 3  # 方向：仓库源 → 运行时（单向，源是唯一真相）
41      # -- 灵魂源（AEMEATH 人格核心；纳入双地落防误改无源可恢复，2026-07-16） --
42      @{n = "soul";           s = "$repo\soul\CLAUDE.md";                  d = "$home_\.claude\CLAUDE.md" }
43  )
...
58  if (-not $Apply) {
59      Write-Host "`n$($drift.Count) mapping(s) drifted. Run .\sync-runtime.ps1 -Apply to sync source -> runtime." ...
60      exit 1
61  }
63  Write-Host "`nApply: syncing $($drift.Count) mapping(s) source -> runtime." ...
64  New-Item -ItemType Directory -Force -Path $backup | Out-Null
65  foreach ($p in $drift) {
66      if (Test-Path -LiteralPath $p.d) {
67          $relative = $p.d.Substring($home_.Length).TrimStart("\", "/")
68          $backupPath = Join-Path $backup $relative
69          $backupDir = Split-Path -Parent $backupPath
70          if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
71          Copy-Item -LiteralPath $p.d -Destination $backupPath -Force
72      }
73  }
74  Write-Host "Backup: $backup" ...
80      Copy-Item $p.s $p.d -Force      # 源覆盖运行时
```

### mirror-gate.py —— check_drift pairs + 漂移哨兵渲染行
```
146      pairs = [
147          ("rules.md", repo / "rules.md", home / ".ai-collab" / "rules.md"),
148          ("output-style", repo / "output-styles" / "aemeath-meta-butler.md",
149           home / ".claude" / "output-styles" / "aemeath-meta-butler.md"),
150          ("soul", repo / "soul" / "CLAUDE.md", home / ".claude" / "CLAUDE.md"),
151      ]
...
153      for name, src, dst in pairs:
154          try:
155              if not src.is_file():
156                  broken.append(name)       # 源缺失
157              elif not dst.is_file():
158                  drifted.append(name)      # 运行时缺失
159              elif hashlib.sha256(src.read_bytes()).hexdigest() != hashlib.sha256(dst.read_bytes()).hexdigest():
160                  drifted.append(name)      # hash 不一致
161          except Exception:
162              unverifiable.append(name)
...
196      if drifted:
197          _parts.append(f"⚠️ 漂移 {'/'.join(drifted)}（跑 {_sync} -Apply）")   # 哨兵给 LO 的建议动作
```

## 评审重点（逐条判决 + file:line 证据）
1. **架构/工作流风险（最重要）**：sync 是"源→运行时单向覆盖"。SOUL 纳入后修改流程变成"改源→sync"。
   (a) 若 LO 习惯直接改运行时 `~/.claude/CLAUDE.md`（人格即兴微调），下次 `-Apply` 会用源覆盖 LO 改动——这是否被"-Apply 前备份运行时 + 开机漂移哨兵"**充分**缓解？备份的可发现性/可恢复性如何？
   (b) 开机漂移哨兵检测到 drift 时无条件建议跑 `-Apply`（第 196-197 行）。SOUL 与其他 15 对有个关键行为差异：它是**最可能被 LO 直接在运行时手改**的文件。哨兵的建议动作在"运行时才是新版本"的场景下是否安全？
   (c) 归属：全局 SOUL（跨所有项目的人格核心）把权威源放进 514cc 单个项目仓库，合理吗？（注：rules.md、output-style 已是同款模式）有没有更该放的位置？值不值得纳入，还是保持 SOUL 单份更稳？
2. **映射方向/路径正确性**：soul 的 s/d 有没有写反？mirror-gate 3 对与 sync 映射是否逐字一致？
3. **mirror-gate 三态逻辑**：对 soul 是否同样成立（读取/权限故障是否进 unverifiable 不假绿灯）？
4. **备份充分性**：第 64-72 行备份逻辑对 SOUL 这种大文件/敏感文件是否可靠可恢复？`$p.d.Substring($home_.Length)`（第 67 行）有无边界隐患？
5. **两处映射表的一致性维护**：sync-runtime.ps1 的 $pairs（16 对，权威）与 mirror-gate.py 内联 pairs（3 对，子集）现在是两处独立维护的映射。有无机制防止二者未来漂移不一致？
6. 主驾/我没想到的任何盲区，尤其"看似安全实则有隐患"。

## 产物格式（严格四节 + 末尾 DELTA 行）
```
## 致命问题（必须改）
## 建议改进（值得讨论）
## 可保留（看似奇怪但合理）
## 总评

__VERDICT__: APPROVED | CHANGES_REQUESTED | REJECTED_FUNDAMENTAL
__DELTA__: soul-double-landing | 0/1/2 | 证据(file:line 或被推翻的原判断)
```
每条问题给"为什么" + file:line。DELTA 净增量：0=无新发现 / 1=补强主驾 / 2=推翻主驾判断。请诚实，不要为凑数编造。
