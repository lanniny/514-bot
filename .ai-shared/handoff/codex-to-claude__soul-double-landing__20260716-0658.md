# Codex 评审：SOUL 纳入双地落（dogfood 治理变更）

- **评审模式**：architecture（架构/工作流决策盲区为主）
- **评审范围**：`soul/CLAUDE.md`（新建源全文）；`scripts/sync-runtime.ps1`（:42 soul 对 + :14/:45-50/:63-83 单向覆盖与备份）；`.claude/hooks/mirror-gate.py`（:126/:135/:146-163 check_drift + :196-202 漂移渲染 + :227-233 cwd 门控）
- **评审时间**：2026-07-16 06:58
- **Codex 模型**：codex-cli 0.144.1（micu provider，reasoning effort xhigh，sandbox workspace-write）
- **总 token**：221,914
- **驱动**：烛（codex-reviewer）；正文由 Codex 独立产出（含故障注入实测），元信息头/交叉验证注记/下游建议由烛综合

---

## 致命问题（必须改）

1. **无方向的 hash 差异被转译成了有方向、会覆盖数据的修复指令。** `mirror-gate.py:153-160` 只能判断两端不同，无法判断仓库源还是运行时才是 LO 想保留的新版本；但 `mirror-gate.py:196-197` 无条件建议执行 `-Apply`，而 `sync-runtime.ps1:45-50,63-80` 会把本轮全部 drift 项从源覆盖到运行时（不只 SOUL）。故障注入把运行时模拟为 `runtime-new`、源为 `repo-old` 后，卡片仍输出"漂移 soul（跑 … -Apply）"。备份只能降低不可恢复性，不能证明覆盖方向符合 LO 意图。**SOUL 是高频被直接手改的运行时文件，与其他 15 对行为特性根本不同**——必须改为方向中立提示：先 diff/确认；源为准时做 item-scoped apply，运行时为准时先回写源。

2. **全局 SOUL 配了项目域哨兵，监控范围小于影响范围。** SOUL 运行时目标是全局 `~/.claude/CLAUDE.md`（`sync-runtime.ps1:42`，作用于该机器所有项目），但 `mirror-gate.py` 在 `check_drift()` 前先用 cwd 做 `514claude` 门控并要求找到 `.ai-shared`（`mirror-gate.py:227-233`）。实测以 `I:\unrelated-project` 启动时 hook 退出 0、输出长度 0。LO 在其他项目改坏/改新全局 SOUL 后所有项目受影响，却要等回到 `514claude` 工作区才可能看到告警。应把"全局关键文件漂移"与"514cc 项目体检卡"拆开：前者每次 SessionStart 都检查，后者继续 cwd 门控。

3. **逐字节复制把旧事实固化成了新权威源，hash 哨兵仍会假绿。** `soul/CLAUDE.md:32,36` 仍把 `~/.ai-collab/rules.md` 标为 v3.3 宪法，而当前宪法已是 v3.4.1（`rules.md:101`）；源/运行时 byte-equal 时 `mirror-gate.py:202` 仍渲染"一致 ✓"。这证明"源=运行时"只代表复制一致、不代表源内容正确。不能把运行时快照未经语义审查就升级为权威源；至少删除 SOUL 中易腐烂的手写版本号，或加与 `rules.md` 当前版本一致的语义校验。

4. **"历史备份目录证明 SOUL 备份可靠"的验收证据不成立。** 任务卡 `claude-to-codex__…0646.md:20` 用历史 `claude-runtime-*` 目录证明备份逻辑跑过，但目录在 `sync-runtime.ps1:64` 无条件创建，只有 `:66-72` 才真正复制文件。当前两个历史目录均只含 `.ai-collab/rules.md`，无 `.claude/CLAUDE.md`——只证明 rules 备份路径跑过，**不能证明 SOUL 对完成过"漂移→备份→覆盖→恢复"闭环**。接受前应做隔离 fixture 或受控演练，验证备份 hash 与明确恢复步骤。

## 建议改进（值得讨论）

1. **消灭两份映射表的人工同步。** 权威表在 `sync-runtime.ps1:21-43`，关键子集又内联于 `mirror-gate.py:146-151`，无机械一致性约束。新增 SOUL 后维护漂移已发生：`mirror-gate.py:135` 仍称"全 15 对"、`:126` 仍只列两类。优先抽出无副作用 manifest 供两端读取；最低限度落持久化测试，断言 mirror 子集 name/src/dst 与 sync 权威表一致。

2. **把备份从"有副本"提升为可恢复事务。** `sync-runtime.ps1:18-19` 秒级目录名无并发锁；`:67` 用 `Substring` 假定目标在 `$home_` 下；`:76-83` 逐项直接覆盖，异常时因 `ErrorActionPreference=Stop`（`:14`）中途退出留下部分更新状态。建议：`GetRelativePath` 后拒绝 `..`、唯一 run id、manifest+前后 hash、临时文件原子替换、逐项结果、生成式 restore 命令。SOUL 仅 22943 字节，大小不是风险，事务性与恢复可发现性才是。

3. **隔离未审查的运行时备份。** `.gitignore:1-3` 未覆盖 `.ai-shared/backups/`，而 `sync-runtime.ps1:64-72` 会把运行时旧版本原样放进仓库树。SOUL 审计源可受控纳入仓库，但备份可能含未审查的即兴修改或敏感片段。建议至少 ignore 备份目录，定义保留期/权限。

## 可保留（看似奇怪但合理）

1. **映射方向与三对路径正确。** `sync-runtime.ps1:42` 明确 `soul\CLAUDE.md`（源）→ `$USERPROFILE\.claude\CLAUDE.md`（运行时），`mirror-gate.py:150` 与之对齐。实测 16 对全一致，SOUL 两端 22943 bytes/333 行/SHA256=`75B685…A734AAF`。**方向未写反**。
2. **三态失败语义正确。** `mirror-gate.py:155-162` 把源缺失/运行时缺失或 hash 漂移/读取异常分别送 broken/drifted/unverifiable；`:196-202` 仅三桶皆空才显"一致 ✓"。对 SOUL 注入 `PermissionError` 后实际进 `unverifiable=['soul']`，**未重现二态假绿灯**。
3. **SOUL 权威源放 514cc 仓库合理。** `sync-runtime.ps1:3-10` 已确立"仓库源→运行时"+"能单份就不复制"原则；SOUL 与同仓 rules/output-style 共组 514cc 人格治理面。问题不在"是否纳入"，而在全局监控范围、方向确认、语义校验、恢复工作流未同步升级。
4. **先备份全部 drift 项、再开始覆盖的顺序对。** `sync-runtime.ps1:64-73` 完成备份阶段后才在 `:76-83` 进入写入；SOUL 相对路径正确算为 `.claude\CLAUDE.md`。保留此顺序，在其上补事务性与恢复 UX。

## 总评

总体架构无需推翻，当前路径、hash、三态异常处理均通过复核；但尚未达到"全局 SOUL 已被安全纳入双地落"的验收口径。最危险的不是 Copy-Item 本身，而是：把无方向漂移包装成 `-Apply` 单向修复、用项目 cwd 守望全局文件、让 byte-equal 掩盖权威源语义陈旧、以及用不含 SOUL 的历史目录冒充备份验收证据。先修上述四项，再做一次可重复的漂移/备份/恢复验收。

---

## 烛的交叉验证注记（守夜人层，非原样转抛）

Codex 全程 workspace-write 沙箱、越 §四"只读"守则自主落盘本 handoff——**已核验：仅写此 handoff + append 审计日志 `.ai-shared/mirror-gate.log`，三个被评审源文件 SHA/mtime 全未变（soul SHA 仍 `75b685…`，sync/mirror mtime 停在 06:38 主驾改动时刻）**。无篡改、无夹带。

我独立复核了 Codex 的关键实证声明，全部属实：
- **致命#2 cwd 门控漏监控**：机理属实（`mirror-gate.py:227-233` 的 `WORKSPACE_ANCHOR` 门控）。**我此前未想到此盲区。**
- **致命#3 语义陈旧实锤**：亲验 `soul/CLAUDE.md:31/32/36` 确写 "v3.3 harness/v3.3 宪法"，`rules.md:1` 已 v3.4。属实。
- **致命#4 备份证据不成立**：亲验两个历史备份目录 `find` 结果**只含 `.ai-collab/rules.md`，无 `.claude/CLAUDE.md`**。**Codex 正确推翻了我任务卡里的证据过度推断**——"备份目录存在"≠"SOUL 备份闭环验证过"。
- **致命#1 方向误导**：我在评审前已独立嗅到同一盲区（哨兵无条件荐 `-Apply` 在"运行时才是新"场景有害），Codex 以故障注入实测坐实——交叉验证成立，证据比我强。

结论：本轮评审高可信。DELTA=2 名副其实（推翻 2 项证据判断 + 新增 2 个未察盲区）。

---

## 下游建议

### 建议召唤
- **策（spec-architect）**：致命#1/#2 是工作流/监控范围的**设计缺陷**（非补丁级），值得出一份"全局资产 vs 项目资产双地落分层 + 方向中立漂移处置"小规格再改，避免打补丁越补越乱。
- 修复后**再召唤烛复评**（reflection R2）：验收"方向中立提示"实现 + SOUL 漂移/备份/恢复闭环受控演练。

### 风险信号
- 致命#1 若不修，下一次 LO 即兴手改运行时 SOUL 后跑 `-Apply` 会**静默丢改动**（备份可捞回但需知道备份在哪）——这正是今天 rules.md 倒挂的镜像风险。
- 致命#3 暴露体系级隐患：**所有 byte-equal 哨兵都只保证"复制一致"、不保证"源内容正确"**——SOUL 只是第一个被发现的实例，rules/output-style 同理需要语义层校验。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: soul-double-landing | 2 | governance | 推翻"历史备份目录证明 SOUL 备份可靠"(sync-runtime.ps1:64 vs :66-72，备份目录实测只含 rules.md)与"byte-equal 即正确权威源"(soul/CLAUDE.md:32 写 v3.3 vs rules.md:1 v3.4)；新增全局 SOUL 被 cwd 门控漏监控(mirror-gate.py:227-233)及无方向 drift 被误导为 -Apply(mirror-gate.py:153-160,196-197)
