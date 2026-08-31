# Codex 评审：Console 团队体系（会话级能力配比 + 内置 514cc 冻结） · R10-R12

- **评审模式**：architecture / security / 并发正确性
- **评审时间**：2026-07-17
- **驱动方式**：CLI `codex exec resume` 同会话（threadId 019f6dda；Codex Windows sandbox shell 异常期间烛自主切 Serena MCP 符号级读盘——评审通道自愈）
- **Codex 模型**：gpt-5.6-sol（xhigh）

## 本轮交付（LO 需求：左栏项目上方团队选择，每会话预设成员/提示词/skill/MCP，隔离能力配比；默认 514cc 团队不可更改）

- **src/teams.mjs TeamStore**：内置 514cc 团队=代码冻结常量（不落盘，update/remove 一律 FROZEN_BLOCK→403）；自定义团队 teams.json 原子写 + #serialize 并发串行 + #commit 落盘成功才提交内存；validate（主脑席位不可移除/成员∈knownProviders/保留名 NFKC/name-prompt-skills-mcp 全过 secret 闸）
- **路由白名单**：router.preview allowedProviders——空白名单 fail-closed NO_ROUTE；主选+独立验证双过滤；preview 端点服务端从 teamId 推导白名单（剥客户端直提），缺省解析 team-514cc 与 create 完全同契约
- **编排注入**：run 固化 teamId/teamName/teamBrief；规划轮前置结构化团队段（[团队配置开始/结束] + 明示不覆盖平台契约）
- **前端**：左栏顶部团队区（aria-pressed 轻列表/内置徽标/重绘焦点恢复/失败保态）+ 管理对话框（内置只读+另存为新团队/自定义编辑删除+二次确认/busy 防双击）+ 拒载 toast 可见
- **诚实边界**：skills/mcp 是声明性配置（注入主脑规划提示词供派工参考），控制面不代理 skill/MCP 执行

## 演进轨迹

| 轮 | 裁决 | 净发现 |
|----|------|--------|
| R10 | CHANGES_REQUESTED | 4 致命：①空成员白名单被 `length ? Set : null` 解释为"不设限制"+init 不校验磁盘记录（手工注入 members:[] 即绕过隔离）②预路由不带团队与正式路由契约分裂③CRUD 原子写≠并发安全（旧快照乱序覆盖丢数据）④自定义团队可冒名"514cc"审计不可区分 |
| R11 | CHANGES_REQUESTED | **烛抓出主驾修复代码里的 JS 语义错误**：`state?.models` 的 optional chaining 绕不过 let 的 TDZ——init 期间仍 ReferenceError 且被逐记录 catch 吞掉→重启后自定义团队全部静默拒载；测试用独立 knownProviders 未踩真实装配路径（假绿）。+4 建议（preview 缺省团队/拒载可见/落盘失败原子性/NFKC） |
| R12 | **APPROVED** | TDZ 以 modelsRef 稳定引用盒子根治 + 真实装配路径集成测试（spawn→建队→重启→存活断言）闭环；余 3 低优建议中 2 条当轮落（skills/mcp secret 闸+拒载 toast），health probe 性能债入 backlog |

## 验证

- node --test **78/78 绿**（teams 7 用例 + router 白名单 fail-closed + e2e 重启存续集成测试 747ms PASS）
- e2e 超时 60→120s：三端点手动计时定位瓶颈=CLI 健康探测冷启动（bootstrap/preview/dry-run 各 25-30s），高负载稳定超线，非业务回归（如实登记 + probe 性能债入 backlog）
- Playwright 实测：内置只读表单/另存为新团队/新建/选中切换/删除回退；API 直打 PUT/DELETE builtin 双 403；teams.json 落盘往返

## backlog（烛判不阻塞）

- instance-lock PID 复用误判（kill(pid,0) 无创建时间/租约校验）→ lease/文件锁库
- CLI 健康探测 25-30s/端点 → 缓存+并行+耗时预算
- 顶层 teams.json 损坏静默吞（rejectedOnLoad 只覆盖记录级）

__VERDICT__: APPROVED
__DELTA__: 烛(codex-reviewer, CLI R10-R12) | 2 | 推翻主驾两层判断——R10 照出"白名单空数组退化为不设限制"的 fail-open（会话隔离核心承诺被绕）与预路由契约分裂；R11 更抓出主驾修复代码自身的 JS 语义错误（optional chaining 绕不过 TDZ，独立单测假绿掩盖装配级回归）——"修复代码也要独立验证"再添实证；三轮收敛 APPROVED
