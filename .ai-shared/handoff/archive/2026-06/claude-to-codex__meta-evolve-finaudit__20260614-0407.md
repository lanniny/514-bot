# 任务卡：514cc 体系进化方案独立终审

你是独立终审官。不要重做诊断。任务是当独立的眼睛挑出"会破坏现有正确设计"的坑，
并对去重正确性 / 优先级排序 / 落地安全性做对抗式复核。用简体中文。

## 背景
36-agent 现场审查产出 24 提案 → 红队过审 21 → 主驾去重为 9 大杠杆点(A-I)。
我(烛)已做磁盘核验 + stop-gate 活体沙盒验证，结果见下。请基于这些硬事实判断。

## 已磁盘验证的硬事实（你可信任，已实测）
1. `.stop-gate-state.json` 真不存在（两处 .ai-shared 都没有）→ stop-gate 从未在真会话击发
2. 但我在沙盒活体验证了 stop-gate 击发逻辑【完全正常】：
   - 缺 DELTA 的 synthesis__ handoff → exit 2 + 写 state + stderr 中文提醒 ✔
   - 同 session 第2次 → exit 0（seen 去重，不死循环）✔
   - 补 DELTA 后新 session → exit 0 放行 ✔
   → 推论：stop-gate 是"静默成功"(每次放行因真实账本都齐全/或超24h窗)，不是"静默失败"。
     主驾诊断1说的"假声明"指的是 rules.md 等四处写"本轮即首次真击发，从无到有"——
     但 state 文件不存在=从未真击发，这层确实是被磁盘证伪的假声明。
3. route-gate.log 有两条【假阳 RED】活体证据：
   - 第8行 `RED  see · ✔ connected · 8 tools...` = 粘贴 MCP 状态文本触发 review/search 子串
   - 第11行 `RED  <task-notification><task-id>wq5...` = 任务通知元数据触发（G 提案没覆盖这第二类假阳）
4. DELTA 账本 6 条全是框架自审（42-agent/Explore/deep-audit/部署核查/ccline/文档审计），WAI 业务 0 条
5. hook 挂载真相（已查 settings.json）：
   - mirror-gate: SessionStart matcher=startup（仅冷启动，/clear 和 resume 不触发），同步，timeout 10
   - route-gate: UserPromptSubmit matcher=空（每轮），同步
   - stop-gate: Stop matcher=空，同步（async 未设）
   - SessionEnd 已被 clawd-hook.js 占用，但 hooks 数组可追加 → I 提案技术可行
6. mirror-gate.py 当前【没有任何写日志代码】（C 提案要新增的 mirror-gate.log 是从零加）
7. 人格双注入：CLAUDE.md(SOUL) 与 output-style(aemeath-meta-butler, 267行) 都自称最高优先级；
   SOUL 用"反驳协议黑洞"安全框架(每回复强制触发短语)，output-style 用"糖衣≠失控"表格框架，二者并存

## 9 大杠杆点
A 诚实债清算(effort S)：四处"首次真击发"假声明改成磁盘真相
B stop-gate 活体击发验证(S)：故意落缺 DELTA 的测试 handoff 观察 exit 2
C mirror-gate 落盘(S)：加 mirror-gate.log 记录注入时间戳
D MCP 去腐+捞真金(S-M)：删幽灵 see/web-reader；scrapling/grok/serena 重构写进能力地图+route-gate触发表；claude-flow 卸载or标实验
E 创造力发散注入器(S-M)：route-gate 复杂/构思档强制"先吐2-3个互斥角度(含1逆向LO假设)再收敛"
F 业务燃料破冰(M)：下次 WAI 真实改动强制走烛+落 business DELTA
G RED↔召唤对账(M)：route-gate.log 加"是否真召唤"列+体检卡显示"近7d RED X次/真召唤Y次"+修RED假阳
H 人格层收敛(S-M,自标高风险)：反驳协议每轮全量→条件触发；指定 output-style 为唯一权威人格层；工具调用纪律反向同步回 SOUL
I 闭环自动沉淀(L)：SessionEnd hook 半自动把"被推翻的主驾判断"提炼成 DELTA 草稿

## 红队已 kill（请复核是否同意）
"统一三处 FIRE_PREFIXES 到单一常量"被 kill：stop-gate(3元含synthesis__) 与 mirror-gate(2元不含)
口径差异是刻意设计(已有显式注释互相引用)，强行收敛会破坏 mirror-gate 外用浓度指标语义。

## 必答四问
1 去重对不对——有无误并/漏并？特别看 B 是否其实是 A 的子集、G 是否吃掉了 C 的一部分。
2 优先级(felt/effort)哪里判错？给出你认为的 Top3 应先做。
3 A-I 里有没有"会破坏现有正确设计"的坑？尤其：
   - B 故意触发 exit 2 会不会卡死本会话收尾？（我已沙盒验证逻辑正常+三重防死循环，你判断真会话风险）
   - E/G 改 route-gate.py 正则会不会重蹈 v3.3 的 preview 子串误判？（现有正则已用 \b 双边界）
   - H 人格大改会不会引入身份漂移/安全框架真空？（两套安全框架并存，删一套的风险）
4 A-I 哪些可【立即安全落】、哪些【必须 LO 拍板】？

## 输出格式（严格四节）
## 致命问题（必须改）
## 建议改进（值得讨论）
## 可保留（看似奇怪但合理）
## 总评
最后给 __VERDICT__ 和你对每个 A-I 的"立即落/LO拍板/不做"三分类一句话表。
