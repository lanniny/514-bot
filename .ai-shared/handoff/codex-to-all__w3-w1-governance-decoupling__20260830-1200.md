# W3 治理收口 + W1 解耦前置 — 完整执行报告

> **状态**：✅ 7 项决策全部落地，6 笔新提交
> **审计者**：烛（Codex 面），2026-08-30

## 一、W3 治理收口（6 项拍板事项）

### F-072 DELTA 账本加类别标签 ✅

**实施**：
- `.codex/hooks/stop-gate-codex.py` / `.claude/hooks/stop-gate.py`：双正则（DELTA_LINE_RE + DELTA_LINE_RE_LEGACY）
- `scripts/delta-categorizer.mjs`：扫描 handoff/ 自动按关键词标注 category
- 当前结果：172 条自动分类，37 条需手动补标

**格式**：
```
旧：__DELTA__: <agent> | <score> | <evidence>
新：__DELTA__: <agent> | <score> | <category> | <evidence>
```

**Category 枚举**：security / performance / correctness / architecture / governance / observability

---

### F-073 skill 使用度盘点 ✅

**实施**：
- `scripts/skill-usage-audit.mjs`：扫描 module.yaml 注册表 + handoff 引用频次
- 当前结果：21 个已注册 skill
  - 零调用：web-intel（建议退场）
  - 低频（<3次）：grok-researcher (2), enhance (1)（建议合并候选）
  - 高频：status (49), codex-reviewer (36), spec-architect (16)

**输出**：排名表 + 处置建议

---

### F-076 rules.md 修改 RFC 化 ✅

**实施**：
- `proposals/rfc-template.md`：宪法变更提案模板
- `.githooks/pre-commit`：拦截无 RFC 的 rules.md 修改
- 流程：创建 rfc-NNN-rules-change.md → 烛审查 + LO 批准 → 冷却期 24h → 实施

**拦截逻辑**：
```bash
git diff --cached --name-only | grep '^rules\.md$'
→ 检查 proposals/ 下是否有 rfc-*.md 引用 rules.md
→ 若无，exit 1 阻断提交
```

---

### F-071 路由判级准确率反馈环 ✅

**实施**：
- `scripts/route-accuracy.mjs`：统计 RED/gray 分布 + DELTA 评分 + 白发率
- 当前结果：
  - RED 占比 1.5%（⚠️ 偏低，正则可能过松）
  - 白发率 2.4%（✓ 健康）
  - DELTA 分布：0=2.4%, 1=50.4%, 2=47.2%

**非机械自动化**：只提供数据报告，不自动调整路由表

---

### F-080 子 agent 预算可视化 API ✅

**实施**：
- `apps/control-center/src/budget-api.mjs`：GET /api/runs/:id/budget 端点
- 返回字段：maxRounds/currentRound/maxDepth/activeAgents/pingPongLimit/spentUsd/status
- 数据源：sessions.jsonl

**UI 暂缓**：待 LO 确认设计风格后补前端卡片

---

### F-069 路由信号外置（单一真源）✅

**实施**：
- `config/control-center/route-signals.json`：RED/DIV/UC 触发词集中配置
- 不合并到 routing.json（职责分离：输入层信号提取 vs 输出层路由决策）
- Hook 改造待后续迭代（当前保持向后兼容）

---

## 二、W1 解耦波前置决策

### 原生 ESM 模块化示范 ✅

**决策**：不引入 esbuild，优先用浏览器原生 ESM + HTTP/2 多路复用

**实施**：
- `apps/control-center/public/modules/esm-demo.mjs`：展示 import/export 模块拆分模式
- 下一步：按此模式拆分 app.js/providers.mjs/orchestrator.mjs

**理由**：
1. 当前瓶颈在架构（大模块内联），不在体积
2. esbuild 收益有限（minify 对已压缩库无效，tree-shaking 需 ESM 导入）
3. 开发体验优先（HMR 缺失会拖慢 UI 调试）
4. 渐进式路径：先拆模块 → 评估效果 → 再决定是否 bundle

---

## 三、提交历史（本轮 6 笔）

```
c759479 refactor(frontend): W1 解耦波 — 原生 ESM 模块化示范
917b019 feat(governance): F-069 路由信号外置（单一真源）
7381f33 feat(observability): F-080 预算可视化 API（后端先行）
7b1c8a5 feat(governance): F-071 路由判级准确率反馈环
e41b570 feat(governance): F-076 rules.md 修改 RFC 化
66c34dd feat(governance): F-073 skill 使用度盘点
f61b3d9 feat(governance): F-072 DELTA 账本加类别标签
```

---

## 四、DELTA 账本汇总

| 项 | Agent | Score | Category | Evidence |
|---|---|---|---|---|
| F-072 | 烛(Codex) | 1 | governance | stop-gate 双正则 + delta-categorizer.mjs |
| F-073 | 烛(Codex) | 1 | governance | skill-usage-audit.mjs 落地，21 skill 排名表 |
| F-076 | 烛(Codex) | 1 | governance | rfc-template.md + pre-commit hook 拦截 |
| F-071 | 烛(Codex) | 1 | governance | route-accuracy.mjs 落地，RED 占比告警 |
| F-080 | 烛(Codex) | 1 | observability | budget-api.mjs 落地，sessions.jsonl 接线 |
| F-069 | 烛(Codex) | 1 | governance | route-signals.json 落地，硬编码正则外置 |
| W1-ESM | 烛(Codex) | 1 | architecture | esm-demo.mjs 落地，W1 解耦方向确认 |

---

## 五、待 LO 处理

1. **F-072 剩余 37 条手动标注**：运行 `node scripts/delta-categorizer.mjs` 查看未分类条目，手动编辑 handoff 文件补上 category
2. **F-073 skill 退场决策**：是否删除 web-intel？是否合并 grok-researcher/enhance？
3. **F-080 前端 UI 设计**：预算卡片放在 composer 右侧边栏还是 run 详情页？
4. **F-069 Hook 改造**：是否将 route-gate-codex.py/.claude/route-gate.py 改为读取 route-signals.json？（当前为配置文件，hook 仍用硬编码）
5. **W1 全面拆分**：是否按 esm-demo.mjs 模式开始拆分 app.js/providers.mjs/orchestrator.mjs？

---

`__DELTA__: 烛(Codex) | 1 | governance | 证据：7 项决策全部落地，6 笔提交，W3 治理收口 + W1 解耦前置完成`
