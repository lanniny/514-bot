# Wave G 五面门闩开放 + codeg UI 移植 + G4 协作星图艺术层（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi（全程主驾亲自动手，蜂群配额已耗尽）· 范围：apps/control-center 全栈 + IA
> 触发：LO 2026-07-25 授权 Wave G（channels/ssh/office/pty/market 五面门闩全做、功能质量向 codeg/LiveAgent 看齐可搬代码、排版 IA 重组，功能在前艺术面最后）

## 一、落地清单

### 1. 五面后端（30 新测试全绿，门闸 v2 授权账本 7 门）

| 面 | 文件 | 要点 |
|---|---|---|
| PTY 终端 | `src/pty.mjs` + `src/pty/routes.mjs` | node-pty ConPTY 会话、环形缓冲 replay、SSE 流（心跳 20s）、input/resize/kill |
| Office 文档 | `src/office.mjs` + routes | docx/xlsx/pptx 进程内生成、dryRun 计划→确认两段、模板/历史/inspect |
| 渠道 | `src/channels.mjs` + routes | Telegram 轮询（`pollIdleMs` 500ms 修微任务饥饿）、出站/入站 Webhook（HMAC 需原文体）、事件流 |
| SSH/SFTP | `src/ssh.mjs` + routes | ssh2 台账、凭据引用制（secrets 永不回显）、指纹三态、exec 超时脱敏、SFTP 路径围栏；漏导出 close 已补 |
| 市场 | `src/market.mjs` + routes | MCP Registry 搜索、skills URL 暂存审查（哈希+文件面）→ confirmed 原子安装；台账 appendInstalled 挂 writeChain 修并发丢更新 |

门闸：`src/security/remote-gates.mjs`；授权账本 `.ai-shared/control-center/remote-gates.grants.json`（7 门，source="LO conversation 2026-07-25"）；**gateway/remote_web 仍封锁**。

### 2. 前端五视图 + IA 重组

- 五面板全量重写：terminal-panel（vendored xterm 6 多页签 + fetch 流式读 + ResizeObserver + closeTab 断 observer）、office/channels/hosts/market-panel（门闸卡/空态/两段确认）。
- IA 5 组 16 项：协作（协作台/团队协作/渠道）· 创建（启动器/文档工坊/终端）· 观测 4 · 资源（市场/远程主机）· 系统 3；topnav 同步可横滚。

### 3. 截图走查抓出的五个真问题（全修）

1. 五面板 script 未登记 server 静态路径表 → 404 全灭（`server.mjs` paths 补登）。
2. `.mjs` 不在静态扩展白名单 → xterm vendor 404（白名单 + MIME 双补）。
3. xterm DomRenderer `setAttribute("style")` + `<style>` 注入违 CSP `style-src 'self'` → vendored 补丁：`_addStyle` 改 CSSOM setProperty；三处 `<style>` 元素改 `CSSStyleSheet + adoptedStyleSheets` 代理。
4. **PTY SSE 帧前端先反转义再 JSON.parse → 含 `\n` 的 chunk 全丢、终端黑屏**（terminal-panel.js 直接 parse；服务端多余转义同步清除并留注释）。
5. waveg.css 臆造 `--forge-*` 变量族暗态穿帮 → 顶部 token alias 层映射 tokens.css 真实变量（var() 使用时解析，暗态自动跟随；panel 侧零改动）。

### 4. codeg UI 移植批（G3）

- 磨砂表面族：`.forge-glass*` + 侧栏玻璃化（color-mix 86% + blur14/saturate150，codeg 数值；老引擎回落纯色）；`.forge-msg-surface`（ws-msg 契约 50% 染色 + 1px ring）。
- 折叠：InstantCollapsible → `grid-template-rows: 0fr/1fr` vanilla（primitives），market 审查卡哈希/文件细节消费（chevron 旋转）。
- `.forge-kbd` 快捷键徽章（codeg SHORTCUT_BADGE 几何）→ topnav 搜索框消费；Shimmer 前波已有等价物（motion.css `.forge-shimmer`）确认不重复。
- **highlight.js v11.11.1 vendored**：`scripts/vendor-highlight.mjs` 机械 CJS→ESM 包装 23 语言（修 `exports.` 误替换致 typescript 内嵌 javascript 的 CLASS_REFERENCE 丢失）；`forge/highlight.css` 双主题 token（对齐 --shiki-dark 契约，全走 tokens.css 语义色）；markdown.js fence 分支 unescape → hljs → 失败回落已转义原文（escape-first 安全模型零新增注入面）；折叠沿用既有 rich-code max-h 渐隐体系。
- 可拖分栏 `splitter.js`：pointer 捕获 + CSSOM setProperty（CSP 安全路径，xterm 同路径实证）+ localStorage 持久化 + 双击复位 + 键盘 ←/→ 步进 + role=separator；协作台左右缝接线，把手绝对定位贴缝不占轨。

### 5. G4 Awwwards 艺术层：协作星图 `#/hero`

- `hero-starmap.js` + `forge/hero.css`；六 CLI 家族节点物理布局（库仑斥力 + 环形锚点缓慢进动 + 阻尼 0.94 + 正弦微漂移）。
- 汉字代号 主/烛/织/前/驻/研（取 agent-roles blurb 语义首字）+ tokens `--agent-*` 品牌色。
- **真实数据驱动**：/api/roster + /api/runs → 活跃节点虚线环 + 活跃边玫瑰流光粒子（30s 慢轮询，非监控面节奏克制）。
- 中心 514 核三层呼吸脉冲；指针引力井（200px）+ hover 放大 + 磨砂名称卡。
- 实验排版：左侧竖排描边巨字「协作星图」+ 竖排拉丁 CONSTELLATION OF SIX CLIS，右下巨型描边「6」+ CLI FAMILIES / ONE FABRIC。
- 主题 MutationObserver 重读 token；reduced-motion 静态一帧全降级；窄屏排版让位。

## 二、验证

- `npm test`：**480 pass / 0 fail / 1 skipped**（481 总）。ConPTY `AttachConsole failed` 全量偶发 1 例，单跑 pty.test 6/6 过——Windows 清理噪音，非回归（复跑回基线）。
- `npm run validate`：12/12，exit 0。
- Playwright 21 站明暗截图巡检：**控制台 0 错误**；终端 cmd banner 实测渲染、分栏拖动实测变轨、高亮 6 语言探针实测、星图 hover 名称卡实测。

## 三、风险与增强债（照实）

- Lark/微信渠道（protobuf/私有协议）、Office 可视化预览（mammoth/沙箱 iframe）、SSH 隧道（LiveAgent TunnelFrame）、跨 run Evidence Graph / Heterogeneous Replay / Counterfactual Dispatch：独立波次。
- 自托管可变字体 + 防闪字脚本（codeg appearance-script 模式）：下波候选。
- KaTeX/Mermaid vendored 实时渲染：沿前波债务继续挂账。
- 桌面端运行实例（cc-desktop + 内核 51400）跑的是旧代码：**需 LO 自行重启桌面端**方见五新面 + 星图（主驾不替 LO 杀窗口）。
- office「用此模板」仅回填标题（spec 通用）；hero 星图为艺术面唯一载体，启动/关于页实验版式未做（克制，避免分散）。

## 四、回退路径

- 五面端点：清空 `remote-gates.grants.json` 对应门授权即回封锁态；前端视图摘 index.html 五个 section + script 标签即可。
- 星图：摘侧栏 hero 项 + view-hero section + hero-starmap.js/hero.css。
- vendored 补丁（xterm/highlight）：删 `public/vendor/*` 对应目录并摘除引用。

__DELTA__: Kimi(主驾) | 1 | security | 证据：terminal-panel.js:60 SSE 帧直接 JSON.parse 修终端黑屏；src/pty/routes.mjs:86 清除多余转义；public/vendor/xterm/xterm.mjs CSP 补丁（CSSOM/adoptedStyleSheets）；server.mjs:457-463 五面板静态登记 + .mjs 白名单；forge/waveg.css:6-30 token alias 层；hero-starmap.js 星图全屏艺术面
