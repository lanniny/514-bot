# 514cc v47 控制面前端全面美化方案 (Forge 3.0 Aesthetic Master Plan)

> 状态：已批准，执行中
> 编制日期：2026-09-03
> 责任 Agent：烛 (Codex 执行官) / Claude Code 主驾
> 目标工程：`apps/control-center`（514cc 协作控制面）
> 视觉定位：**Forge 3.0 — 人文暖纸·微光晶体·AI 原生协作工作台**
> 核心原则：美学惊艳（Aesthetic Delight）+ 性能零负担（Zero-bloat Performance）+ 工程防劣化（Anti-regression Gates）

---

## 0. 设计哲学与视觉北极星

514cc 控制面不仅是一个技术控制台，更是 LO 与多 AI 伙伴（Claude、Codex、Grok、Kimi、Pi 等）并肩思考与协同创作的数字工坊（Atelier）。

经过前期数个版本的迭代与 Wave 0 的基础加固，界面已具备完整的功能链路与扎实的测试基线。本方案（Forge 3.0）旨在将过去碎片化、冷淡单调的界面形态全面升级，确立四大视觉核心：

1. **人文暖纸与深棕墨韵（Warm Paper & Deep Ink）**：
   - 坚守 Claude 人文底色，以米白暖纸（`oklch(0.978 0.004 95)` / `#faf9f5`）与暗夜暖棕黑（`oklch(0.19 0.008 60)` / `#1e1c17`）为基底，彻底摒弃刺眼的纯冷白与死寂纯黑。
   - 点睛色锁定为极具工匠温度的铜橙（`oklch(0.672 0.131 38.7)` / `#D97757`），文字场景严格使用经过 WCAG AA 对比度校准的 `--accent-ink`（`#a95430` / `#f0a483`）。

2. **光影表面与晶体质感（Surface Elevation & Crystal Glassmorphism）**：
   - 建立 4 层清晰的表面深度体系（Level 0 Canvas → Level 1 Panels → Level 2 Cards → Level 3 Floating Capsule/Modal）。
   - 用户壁纸模式下，卡片通过 `--forge-card-alpha` 动态透光，辅以细腻的 1px 半透微光描边（`--glass-border`）与内发光，实现如温润晶石般通透而不失对比度的质感。

3. **呼吸感与多 Agent 品牌共生（Breathing Dynamics & Heterogeneous Agents）**：
   - 为不同的执行伙伴注入专属的微光光谱（Claude 铜橙、Codex 蔚蓝、Grok 魅紫、Kimi 暖金、Pi 碧蓝），使团队协作具有强烈的生命感与辨识度。
   - 状态指示灯与思考块带有优雅平滑的呼吸动效，让“AI 正在思考/执行”变成一种安心舒适的视觉陪伴。

4. **物理弹簧微手感与极致排版（Spring Physics & Typographic Discipline）**：
   - 引入微弹簧缓动曲线（`cubic-bezier(0.16, 1, 0.3, 1)`），按钮具备按压触感反馈，输入台具备平滑展开手感。
   - 数据面强制应用 `tabular-nums` 等宽数字，正文行长受控于 `--measure: 68ch` 黄金比例，消除长行阅读疲劳。

---

## 1. 表面标尺与设计 Token 体系 (Elevation & Tokens)

### 1.1 四层表面深度（Surface Elevation Scale）

| 层级 | 标尺变量 | 典型组件 | 亮态表现 | 暗态表现 |
|---|---|---|---|---|
| **Level 0** | `--surface-level-0` | 画布底座、桌面壁纸视窗 | 暖米底 `#faf9f5` / 壁纸 | 暖棕黑 `#1e1c17` / 壁纸 |
| **Level 1** | `--surface-level-1` | 侧边栏、右工具轨、顶栏 Chrome | 半透毛玻璃（blur 16px）+ 浅暖灰边 | 深棕半透玻璃 + 12% 边框 |
| **Level 2** | `--surface-level-2` | 消息块、内容卡片、配置面板、代码块 | 暖白纸卡 `#fdfcf9` + 漫反射微阴影 | 浅暖黑 `#282520` + 微发光阴影 |
| **Level 3** | `--surface-level-3` | 悬浮输入台、命令面板、下拉菜单、Modal | 立体浮雕 + 24px 模糊 + 铜橙内描边 | 深悬浮舱 + 多重深阴影 + 柔光描边 |

### 1.2 晶体微光边框与阴影

- `--glass-border`: 结合 `color-mix` 构造自适应环境光的 1px 半透描边；
- `--glass-inset-glow`: `inset 0 1px 1px 0 rgba(255, 255, 255, 0.25)`（顶部高光入射角）；
- `--shadow-floating`: `0 20px 35px -8px rgba(0, 0, 0, 0.12), 0 0 1px 1px rgba(0, 0, 0, 0.05)`；
- `--glow-accent-subtle`: `0 0 24px -4px color-mix(in oklch, var(--primary) 20%, transparent)`。

---

## 2. 协作台核心交互视窗升维 (Workbench)

### 2.1 消息时间线气泡与卡片分型

- **用户消息（User Prompt）**：
  - 采用右上角自适应气泡，浅暖色微凸纸面底，右侧微光边框，与 AI 回复在空间上形成清晰的对话韵律。
- **思考链（Thinking Chain / Deliberation）**：
  - 折叠态：展示为浅色微晶胶囊（“● 思考用时 3.2s”），伴随缓慢呼吸的小光点；
  - 展开态：左侧以 2px 浅铜橙渐变线贯穿，内容采用字号略小、行高舒适的柔和排版，背景为透光的深层微凹纸底。
- **工具调用卡片（Tool Call Pill & Output）**：
  - 头部为紧凑状态药丸：状态点（运行中-青蓝脉冲、成功-翡翠绿、失败-赤陶红）、工具名称、执行耗时；
  - 参数与结果代码块自适应语法高亮，输出超出 200px 时自动添加渐变羽化遮罩与“展开全部输出”动作，防止超大日志霸屏。
- **审批卡片（Approval）与提问卡片（Question）**：
  - 外边框采用琥珀金与玫瑰铜的半透磨砂渐变，内部将风险操作（Shell 命令、写操作、文件删除）做显式黄色标示，按钮具备明显的层级梯度（主操作强调 vs 拒绝按钮沉着）。
- **终态结算卡片（Settlement & Delivery）**：
  - 任务完成时呈现具有工匠印章感的交付卡片，列明本次 Run 的 Git 变更摘要（红绿文件胶囊）、测试通过率及证据链链接。

### 2.2 悬浮胶囊输入台（Floating Composer Capsule）

- 彻底摆脱传统紧贴视窗底部的沉重通栏，演进为居中浮动的**圆角胶囊工作台（Capsule）**；
- 胶囊内高度整合：
  - 左侧：输入模式切换器（Plan / Build / Review）、多模态附件徽章；
  - 中间：自动伸缩自适应高度的多行输入框；
  - 右侧：@成员唤起快捷钮（显示已指派 Agent 的彩色微头像）、预算/努力度快速调节、极具点击手感的发光发送按钮；
- 聚焦（Focus）时胶囊边框触发丝滑的光晕扩散，失焦时柔和隐入背景。

---

## 3. 团队星图与能力矩阵 (Team & Topology)

### 3.1 成员卡片立体光感

- 每个 Agent 成员卡片根据其所属角色赋予微型彩色身份徽标；
- Hover 触发微立体位移（`translateY(-3px)`）并透出背部专属品牌光晕；
- 席位状态（Healthy/Busy/Degraded/Offline）使用多态呼吸小光球展现。

### 3.2 能力与席位配置矩阵

- 表头采用毛玻璃固定（Sticky Glass），滚动时内容在表头下方隐约透出；
- 鼠标滑过某一列或某一行时，交叉十字轴同步泛出高对比半透光晕，彻底解决“密集复选框看串行”的问题；
- 复选框升级为现代自绘晶体样式，选中时伴随微缩放动效。

### 3.3 协作星图（#/hero）

- 采用纯 CSS/SVG 沿轨光流脉冲，连接各 Agent 节点的拓扑网络中可见微光数据脉冲匀速流动；
- 极致轻量，零 JS 循环占用，低功耗设备依然满帧流畅。

---

## 4. 观测与看板现代化 (Observability & KPIs)

### 4.1 KPI 指标卡

- 主数字采用 `font-variant-numeric: tabular-nums` + 阶梯字重，强化纵向扫读清晰度；
- 关键指标卡内嵌迷你 Sparkline 走势曲线与环形进度条，数据一目了然。

### 4.2 现代会话与事件表格

- 表格行由生硬的边框线改为卡片式微浮雕隔行悬浮；
- 状态列全面应用玻璃珠微胶囊（Glass Gem Pills）。

---

## 5. 抽象品牌矢量插画与空态资产系统 (Illustrations)

在 `placeholders.js` 中内置 5 套轻巧精美的纯 SVG 几何抽象品牌插画（体积 < 3KB，零网络请求）：

1. **星图罗盘（Astrolabe Compass）**：无任务或欢迎启动态；
2. **折叠棱镜（Folded Prism）**：无搜索结果或筛选无匹配；
3. **古铜挂锁（Bronze Keyhole）**：门闩拦截或需要用户权限确认；
4. **平衡印章（Wax Balance Seal）**：交付完成或当前无可待办项；
5. **星轨断链（Severed Orbit）**：连接中断或请求重试态。

---

## 6. 物理弹簧微动效与手感 (Spring Physics)

- 引入标准弹簧缓动：`--ease-spring: cubic-bezier(0.16, 1, 0.3, 1)`；
- 按钮点击瞬态微缩（`scale(0.97)`）；
- 对话框与抽屉展开平滑缩放融入；
- 骨架屏反光采用倾斜 15 度流光扫光（Shimmer sweep），与真实卡片 1:1 零布局跳动（0 CLS）；
- 无条件遵守 `prefers-reduced-motion`，杜绝光敏与眩晕风险。

---

## 7. 实施计划与验证闭环

1. **Step 1**: Token 标尺与微光基建 (`tokens.css`, `primitives.css`)
2. **Step 2**: 品牌抽象矢量插画与空态升级 (`placeholders.js`, `placeholders.css`)
3. **Step 3**: 协作台消息流与悬浮输入台 (`workbench.css`, `codex-desktop.css`, `rail-tools.css`)
4. **Step 4**: 团队成员卡与能力矩阵 (`team.css`, `hero.css`)
5. **Step 5**: 观测看板与现代数据表格 (`overview.css`, `data.css`)
6. **Step 6**: 物理微动效与门禁复核 (`motion.css`, `ui-baseline.json`, 回归测试与实拍)
