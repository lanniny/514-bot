# PM 全项目审查：514cc v3.5.0（2026-08-29）

- 评审范围：仓库全局（治理层 rules/module/账本 + 产品层 apps/control-center + 协作卫生）
- 评审时间：2026-08-29 22:24 ~ 22:40（绝对时间，UTC+8）
- 评审角色：项目经理视角 + 烛（Verdent 运行时）独立眼睛
- 说明：本会话无 route-gate 注入的 session marker，按"不得猜测、不得留占位符"规则省略该行。

## 致命问题（必须处理）

- [git 仓库（I:\514claude\514cc\.git）] **Git 证据链断裂**。当前仓库仅有一个提交 `603056d` "Initial commit"，提交时间 **2026-08-29 22:23:50 +0800**（本评审开始前 48 秒），且 `git remote -v` 为空、工作树 clean（2910 个 tracked 文件全部纳入该单提交）。而 `.ai-shared/context.md:116` 与 `D-2026-08-18-013` 记录：产品快照 `2b1892c73a7d...` 已推送 `origin/main` 并经 `ls-remote` 回读，`qa:delivery --strict` tracked=379 pass。两处记录在当前仓库中**不可达、不可验证**。为什么是问题：宪法 §二.5 Integrity Gate 要求"区分我认为和我验证了"，交付证据链的物理载体（.git）与账本承诺脱钩后，R3-01 release record、v42 must-ship 闭包全部失去可回溯落点。建议：①LO 确认是否存在仍持有 `2b1892c` 的远程或另一份仓库；②若远程仍在 → 立即恢复 remote 并对账合并基线；③若是有意重置 → 在 decisions.md 补一条新决策说明重置原因与新基线，否则按事故处理（先备份当前 `.git` 再排查）。

- [`.ai-shared/context.md:4`] **短期记忆过期 8~11 天**。context.md 最后更新 2026-08-18，但 `decisions.md:8/35` 已有 2026-08-22 的 514 Bot 重塑两连决策（Bot Shell v0、默认入口切 `bot`），handoff 最新到 2026-08-26。为什么是问题：全体 agent 按纪律"先读 context.md"接入，会拿到过期图景去执行新任务；8 月下旬的 Bot 波次在"当前活跃状态"里完全缺席。建议：立即补一次 context.md 收口；并在 mirror-gate 体检卡加一项"context.md 新鲜度 vs 最新 handoff/决策时间差 > 7 天即告警"——把这条软纪律下沉为机械检查（对齐 rules.md §三"元执行"精神）。

## 建议改进（值得讨论）

- [`.ai-shared/handoff/`（245 文件）、`.ai-shared/decisions.md`（4737 行）] **账本膨胀且归档纪律未执行**。handoff 月度分布 2026-05:3 → 2026-06:26 → 2026-07:89 → 2026-08:121，全部平铺在根目录；archive skill（co-archive）存在但从磁盘看从未运行。decisions.md 4737 行只追加不压缩。建议：①handoff 30 天前文件归档至 `archive/YYYY-MM/`（co-archive 本来就是只移动不删除）；②decisions.md 采用"年度分卷 + 主文件索引"，移动不删除不违反追加式纪律；③把归档检查挂进 mirror-gate 提醒或 npm script，停止依赖"人记得跑"。

- [`rules.md:110`、`module.yaml:3`、`CHANGELOG.md:9`] **版本升格决策悬置 6 周**。三处真源停在 v3.5.0（2026-07-17），而 v4.0 波次（2026-07-25 起）、v42 Git 闭包、514 Bot 重塑均已深度落地；`context.md:120` 自己标注"版本升格待 LO 决策"。悬置越久，正式真源与实际能力面的剪刀差越大，新 agent 误判成本越高。建议：LO 拍板后发 v4.0.0 正式 CHANGELOG 条目（partial 项如实标注），一次性收束。

- [仓库根目录、`apps/control-center/`] **磁盘卫生债**。根目录 60 张 PNG（e2e/qa 截图）+ `debug.log` + `.repro-fixed.jpg/mp4`；control-center 下 13+ 个 `.log` 与 6 个 `.test-shutdown-server-*` 残留。`.gitignore` 的 `/*.png`、`*.log` 已挡住入库，但磁盘证据与垃圾混在一起。建议一次性清理（截图若被 handoff 引用先核对），并在 qa:delivery 或 mirror-gate 加"根目录临时文件计数"检查。

- [`.gitignore`] **重复段落**。从 "Auto-generated entries" 起的第二段与前面手写段大量重复（`node_modules/`、`dist/`、`*.log`、`.env`、`.tmp` 等各出现两次），后续维护容易改一半漏一半。建议合并去重。

- [`module.yaml:293`] **治理层演进停滞 vs 产品层狂奔**。8 月下旬 121 个 handoff 几乎全是 control-center/bot 产品波次；治理面（rules/module/skills）自 v3.5 无实质演进，且 control_center.phase2 的 P1（路由信号外置合一 + summoned 审计闭环）仍挂账未闭环。建议在版本升格同时排一个"治理收口波"。

## 可保留（看似奇怪但合理）

- [`guardrails/deny-paths.txt:14-61`] 凭据/钱包/系统路径/自身配置四段覆盖完整，glob 语义清晰，"不替代宿主权限系统"的定位声明准确。
- [`.claude/hooks/`] fail-open 设计（route-gate/mirror-gate 异常放行、stop-gate 仅 exit 2 逼补）与"注入=硬、拦截=软"的宪法分层一致，是对的。
- [`decisions.md` 4737 行只追加] 纪律本身正确（防篡改、可审计），问题仅在缺归档机制，已在建议节处理，不需要改纪律本身。
- [根目录 e2e-*.png 存在] 是 QA 走查的证据留痕，存在合理；只是需要定期清场而非禁止产生。

## 总评

514cc 的纪律设计（路由门、DELTA 账本、三 gate 接电、验证入口契约）在个人 AI 协作体系里属于第一梯队，真正的风险不在"没有纪律"，而在**证据链的物理载体开始漂移**：Git 单提交+无远程 vs 账本里的"已推送 origin/main"，context.md 落后 11 天，账本体量增长没有机械消费者。建议下一个波次不做新功能，先做三件套：**Git 证据链修复/确认、context.md 收口 + 新鲜度检查、归档自动化 + 版本升格拍板**。产品层（Console/Bot）的推进质量本身是高的，但它的可信度建立在证据链上——先修地基，再盖楼。

__DELTA__: 烛(Verdent) | 1 | governance | 证据：git log 单提交 603056d@2026-08-29T22:23:50+08 且 remote 为空，与 context.md:116 "快照 2b1892c 已推送 origin/main" 记录矛盾，主驾账本此前未发现该断链。
