# 布局深度优化：面包屑 / 深色泄漏 / 孤儿绿点 / 三栏比例（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 壳层 + 工作台栅格 + 氛围层
> 触发：LO「请你深度思考优化前端布局」

## 一、诊断方法

不靠肉眼猜：静态 CSS 审计（styles.css 三个时代定义层叠）+ Playwright 运行时取证（getComputedStyle / elementFromPoint）。五个真问题全部定位到具体文件行号。

## 二、五刀清单

| # | 问题 | 根因 | 修法 |
|---|------|------|------|
| 1 | 顶栏 20px 大标题与内容 H1 同词重复（双标题） | shell.css 把 .topbar-title strong 放大到 text-xl | 顶栏降级为面包屑「分组 / 当前页」12.5px：index.html 加 `#current-view-group`，app.js 加 `FORGE_VIEW_GROUPS`（IA 五组映射）+ setView 同步 + cacheElements 登记；shell.css 重写 topbar-title 段 |
| 2 | 协作台左列渲染出深色块（亮态穿帮） | `--sidebar: #181a1f` 是图标轨时代深色值，run-rail `background: var(--sidebar)` 直接消费 | tokens.css bridge 段补 `--sidebar/-hover/-active` 三变量（亮 #f4f1ea 族 / 暗 #17140f 族） |
| 3 | 氛围层玫瑰光晕残留（换暖底后色调偏粉） | atelier.css mesh 径向渐变还是 rgba(180,35,77) / rgba(255,120,152) | 换铜橙族 rgba(217,119,87,.05) / rgba(232,145,111,.07) |
| 4 | 侧栏底部孤儿绿点（无文字、居中游离） | styles.css:7020 图标轨时代 `.runtime-indicator > div { display:none }` + footer grid place-items:center | shell.css：`.atelier .runtime-indicator > div { display:block }` + footer 改 block 左对齐 |
| 5 | 工作台 run-rail 205px 会话条目挤字 | styles.css:1210 旧栅格 `205px / 1fr / 300px` | forge/workbench.css 末尾覆盖 `232px / 1fr / 312px`（规避 styles.css CRLF 混合行尾） |

顺手：page-heading H1 收敛 clamp(22px,1.8vw,26px)、margin 22→18（shell.css）。

## 三、查实保留的既有设计

协作台页 eyebrow/lede 被 styles.css:7263 `#view-workbench .page-heading .eyebrow, p { display:none }` 故意隐藏（compact-heading 给聊天面省垂直空间）——不是 bug，保留。

## 四、验证

- `npm test` 480 pass / 0 fail / 1 skipped（481 总）；`npm run validate` valid。
- Playwright 21 站全量 + 星图补拍 2 站，明暗双主题亲眼走查：面包屑各组正确（协作/创建/观测/资源/系统）、footer「点 + API 已连接 / 版本号」归位、run-rail 深色块消失、暗态终端与星图协调；控制台 0 错误。
- 桌面端静态资产免重启，Ctrl+R 刷新生效。冒烟实例 :5520 已回收。

__DELTA__: Kimi（前） | 1 | security | 证据：app.js FORGE_VIEW_GROUPS + tokens.css bridge --sidebar 三变量 + shell.css:7020 覆盖，23 站截图亲查 0 控制台错误
