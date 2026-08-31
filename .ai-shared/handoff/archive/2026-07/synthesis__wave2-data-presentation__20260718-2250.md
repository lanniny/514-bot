# 波次2 数据呈现补全批——主驾接力实现 + 烛评审返工闭环（2026-07-18）

背景：Kimi 蜂群波次1 全绿（风格令牌 / 后端 steer 队列 + 版本内容端点 / 会话流核心四件）后，波次2 coder 额度耗尽失败、零落盘。LO 指令"接续他的任务"，主驾接力。

## 交付（P1 四件全落）

| # | 件 | 落点 | 实拍证据 |
|---|----|------|---------|
| 1 | 消息级 token/成本徽标 | orchestrator `agent.turn_completed` 补 `tokens` → app.js turn-meta 渲染 | 真实 haiku 轮"第 1 轮完成 · Claude · claude-haiku-4-5 · 55.4k tokens · $0.33" |
| 2 | 路由候选表 | index.html #router-candidate-body + renderRouter 全表 | 6 候选：1 入选高亮、5 排除带真实原因（含探针超时） |
| 3 | 漂移 pairs 明细 | index.html #obs-drift-body + renderObservability 三态 | 15 对全渲染；人造漂移场景 drifted:1 明细可达 |
| 4 | 轮间插话前端 | GOVERNANCE_EVENTS steer 两条 + composer 占位/排队 toast | 后端排队行为 5 条单测；占位/toast 分支落地 |

## 评审闭环（烛 · Codex MCP 对话桥同会话三轮）

- R1/R2 评审：**CHANGES_REQUESTED**（handoff：codex-to-claude__wave2-data-presentation__20260718-2130.md）
- **P0 返工**（主驾本批引入的回归）：drift() 把 exit 1（脚本契约=有漂移）当失败。修复=sync-runtime.ps1 trap exit 2 契约三分 + drift() 0/1 解析 + missing 行入 pairs + 零对账 fail-closed
- 建议 2/3/4/6/7 全修（先脱敏后截断/失败行防覆盖/空白串防御/候选结论 redact/steer 刷新）
- R3 回炉复检：**SECURE**——"P0 和本轮要求修复的呈现链已闭环"；两条建议级备忘（Apply 注释精度/纯空白串）已顺手消灭
- 附带斩获：**PSModulePath 继承陷阱**（node spawn powershell 5.1 → Get-FileHash 加载失败 → exit 1 零输出被旧代码读成"全部一致"假自信）——新明细表逼出的真实静默失败，已修 + 存全局 memory

## 验证账（全部当轮读盘/实测，非记忆）

- node --test **97/97**（含新增 turn_completed tokens 断言）
- P0 核心场景 E2E：人造 ccline-theme 漂移 → API 200 + drifted:1 + 明细含 drift 行 → 还原 → drifted:0
- sync-runtime.ps1 手跑正常路径 exit 0；Playwright 实拍四件全绿

## 遗留（待 LO 拍板）

1. **P1 竞态**（烛独有发现）：orchestrator save 无 per-run 锁，与 steer push/shift 并发可丢失/重复用户插话——建议派 Codex executor 单独修 + 补并发测试（threadId 019f756a-7bbf-7231-9d65-66f83dada46d 可续）
2. 建议5（仅旧收尾事件回放吞正文）留 roadmap
3. **514cc 不在任何 git 仓库内**——今日全部改动无版本控制保护，建议 git init + 首 commit（等 LO 指令）

__DELTA__: 烛(R1-R3 对话桥) | 2 | P0 推翻主驾"exitCode!==0 一律失败"的修复判断（observability.mjs:213 vs sync-runtime.ps1 exit-1 契约，真漂移场景明细不可达）+ P1 save 竞态为烛独有发现

---

## 追加（2026-07-18 深夜）：P1 竞态修复七轮闭环 + git 上仓

LO 授权"继续完善 + git 上传"后：

- **P1 save 竞态及全部衍生生命周期洞修复**（细目见 decisions D-2026-07-18-006）：同 tick 快照回写 / per-run 写盘链 / 墓碑体系 / 活跃协程清理门闩 / close 循环收敛 / init 落盘先行 / 取消回执优先 / 收尾窗口插话补收
- **烛 R3→R8 六轮增量评审**（同 threadId 续聊不冷启动），每轮均有真发现、逐轮闭合，终验 **SECURE**
- 测试 98 → **111/111**（+13 并发/生命周期护栏，含门闩式竞态测试）
- **git**：e340279（首提 359 文件）+ 6eff70b（生命周期修复）→ `github.com/lanniny/514-Control-Center-` main；SSH 走 ssh.github.com:443 绕代理 fake-ip；暂存密钥扫描零真凭据
- Roadmap：drainSteer user.message 窗口清理专测、cancel×adapter 失败并发状态优先级、建议5 旧事件回放合并策略

__DELTA__: 烛(R3-R8 对话桥) | 2 | R4-R7 连续四轮推翻主驾"已修复完毕"判断（生命周期洞 11 个全部烛独立发现或双确认，file:line 见 codex handoff 与 decisions D-006）；R8 SECURE 收敛
