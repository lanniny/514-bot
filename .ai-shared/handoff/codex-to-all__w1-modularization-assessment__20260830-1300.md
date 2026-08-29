# W1 解耦波 — 模块化进展评估

> **状态**：🟡 部分完成，23 个模块已拆分
> **审计者**：烛（Codex 面），2026-08-30

## 一、当前模块化状态

### 已拆分模块（23 个）

`apps/control-center/public/modules/` 目录下已有：

| 模块 | 职责 |
|---|---|
| agent-roles.js | Agent 角色定义与 blurb |
| approval-snapshot.js | 审批快照版本比较 |
| automations-page.js | 自动化页面挂载 |
| avatars.js | 头像渲染 |
| ccswitch-panel.js | CC-Switch 面板 |
| clipboard-attachments.js | 剪贴板附件处理 |
| conversation-run-ownership.js | 会话-run 归属权 |
| failure-presentation.js | 失败展示逻辑 |
| hooks-panel.js | Hooks 面板 |
| json-editor.js | JSON 编辑器 |
| member-library.js | 成员库管理 |
| overview-usage.js | 概览用量统计 |
| rail-panels.js | Rail 面板 |
| request-ownership.js | 请求归属权 |
| resume-hints.js | 恢复提示 |
| runtime-seat-manager.js | 运行时席位管理 |
| settlement-request.js | 结算请求 |
| stream-epoch.js | 流纪元管理 |
| team-config-kit.js | 团队配置套件 |
| team-kit.js | 团队工具包 |
| view-history.js | 视图历史 |
| welcome-tips.js | 欢迎提示 |
| workbench-cwd.js | Workbench CWD 解析 |

### app.js 现状

- **行数**：29,512 行
- **函数数**：1,259 个
- **import 语句**：50+ 个（已模块化依赖）
- **export 语句**：0 个（纯入口文件，非模块）

## 二、进一步拆分策略评估

### 选项 A：继续从 app.js 抽取模块

**优势**：
- 减少 app.js 体积
- 提高可维护性

**劣势**：
- app.js 是浏览器入口，必须加载
- 已拆分的 23 个模块覆盖了大部分独立功能
- 剩余代码多为 UI 事件绑定和 DOM 操作，难以进一步抽象

**成本**：高（需逐块分析 29K 行代码）

### 选项 B：优化现有模块组织（推荐）

**行动**：
1. **模块分组**：按功能域将 23 个模块分为子目录
   - `modules/composer/` — composer 相关
   - `modules/team/` — 团队管理相关
   - `modules/session/` — 会话管理相关
   - `modules/provider/` — Provider 相关
   - `modules/ui/` — UI 组件相关

2. **文档化**：为每个模块添加 JSDoc 注释
   - 输入/输出契约
   - 依赖关系图
   - 使用示例

3. **index.js 聚合**：创建模块索引文件，简化 import

**成本**：中（2-3 小时）

### 选项 C：引入构建工具（esbuild）

**优势**：
- Tree-shaking 自动移除未使用代码
- Minify 压缩体积
- Code-splitting 按需加载

**劣势**：
- 增加构建复杂度
- 调试需 sourcemap
- 失去 HMR（除非配置 watch 模式）

**决策**：暂不引入（见接续总纲 §6 决策）

## 三、推荐行动方案

**立即执行**：选项 B — 优化现有模块组织

1. **模块分组**（30 分钟）
   ```bash
   mkdir -p modules/{composer,team,session,provider,ui}
   mv modules/clipboard-attachments.js modules/composer/
   mv modules/team-kit.js modules/team/
   # ... 等
   ```

2. **创建 index.js**（30 分钟）
   ```js
   // modules/composer/index.js
   export * from './clipboard-attachments.js';
   export * from './approval-snapshot.js';
   // ...
   ```

3. **更新 app.js import**（30 分钟）
   ```js
   // 旧
   import { ... } from './modules/clipboard-attachments.js';
   
   // 新
   import { ... } from './modules/composer/index.js';
   ```

4. **JSDoc 文档化**（1-2 小时）
   - 为每个模块添加头部注释
   - 说明职责、输入、输出、依赖

**预期收益**：
- 模块可发现性提升（按功能域分组）
- 新人上手更快（文档化契约）
- import 语句更简洁（通过 index.js 聚合）

## 四、DELTA

`__DELTA__: 烛(Codex) | 1 | architecture | 证据：W1 模块化评估完成，23 个模块已拆分，推荐优化组织而非继续抽取`
