# 壁纸「启动失效」真因修复（60MB 视频 × 15 并发 GET）+ MCP/Skill 能力面 UI 优化

- 执行者：烛（ZCode 运行时，AEMEATH 面）
- 时间：2026-08-30 19:40 ~ 20:35（UTC+8）
- 依据：LO 指令「自定义壁纸失效了在我启动的时候请你修复；继续优化 MCP 和 Skill 等的布局优化主要是 UI」
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 一、壁纸启动失效：真因不是水合，是预览缩略图把字节管线打爆了

**排除项**（全部实测完好）：服务器侧 `preferences.json` 的 `preset:"custom",hasCustom:true`、`teambg--__global__.mp4` 字节（60,648,875B，LO 换了新的大视频壁纸）、内核启动（boot log 1-2s 出握手）。

**真因**（新探针 `scripts/qa-wallpaper-repro.mjs` 用 LO 真实偏好+真实 60MB 视频字节复现 + fetch 调用栈取证）：壁纸**预览缩略图**（外观面板的 meta 行）每次渲染都 `requestBlob` 全量拉字节，零缓存零单飞。冷启动链路是：空 localStorage → 水合回填 → `replayAppearanceFromStorage` 重放全部外观 apply → 每个 apply 触发 `syncAppearanceControls → renderGlobalWallpaperCard → renderGlobalWallpaperPreview` → **14 个并发 60MB GET**，外加挂载自身的 1 个 = 15 个并发请求 ≈ 900MB 瞬时流量。repro 实测（快盘）：4.5 秒内 15 次 200、挂载耗时 5.3s；LO 的冷盘+杀软环境必然更慢 → 非 404 退避重试再拉 → 摘除路径 →「启动时失效」。v8.5 修的水合竞态是真的但不是全部——这一层在单飞缓存之外的「旁路消费者」上。

**修复**：`fetchGlobalWallpaperMediaRef()` 提为模块级单飞（原是 applyGlobalWallpaperInto 的闭包），预览/挂载/尺寸展示全部共享同一份 `{url,type,size,isVideo}` 缓存；preview 加签名幂等（hasCustom×blobURL 未变不重绘）。

**验证**（同探针复跑）：`/api/wallpapers/global` GET **15 → 1 次**；60MB 视频挂载 **5290ms → 909ms**；偏好全程完好、零错误。探针入库可随时复跑。

## 二、MCP/Skill 能力面 UI 优化（真实数据光照：module.yaml + skills 目录拷入 fixture，MCP 合成数据不带凭据）

走查截图（`scripts/qa-caps-walk.mjs`，明暗可复跑）发现的布局问题与修复：

1. **Skill 矩阵行密度**：描述两行截断 + 行距大，20 行要滚三屏 → 描述收敛单行（悬停 title 看全文）、行距收紧、成员列收窄（92-128px），同屏可见行数 +20%。
2. **MCP 能力映射不可读**：「capability → servers」挤成一堆等宽 chip 流 → 改两行式条目卡（能力名加粗在上、映射服务在下）+ grid 等宽三列；顺手修掉 `.cap-map` flex 容器里 grid 子项收缩到内容宽的布局 bug（`flex: 1 1 100%`）。
3. **能力矩阵 sticky 首列/表头**：实底白（面积小于审计阈值逃过扫描），壁纸态同步玻璃化（hi 档 + 磨砂）——审计重新清零。
4. 走查截图确认 matrix 表头 sticky 与首列冻结本就正常，勾选三态维持原语义（部分态由行/列 N/M 徽标承载）。

## 三、验证

- `qa-wallpaper-repro`：1 次网络 / 909ms 挂载 / 零错误 / 偏好完好。
- `qa-glass-audit`：12 视图清零（仅存 security 暗色日志窗，有意保留）。
- `qa-caps-walk`：skills/mcp 两工作区 + 逐屏滚动实拍。
- 契约：capability-flow-ui / capability-matrix-bulk / capabilities / global-wallpaper-http / ambient / composer / ui-lint **61+ 全绿**。
- `npm test` 全量 1890/1902——10 失败均为既有/波动族（title-glyph 属上轮 index.html WIP；delivery-manifest/run-diff 因本轮文件未提交工作树脏，提交后自愈）。

## 四、遗留

1. composer-shell color-mix 悬案（前轮 CDP 证据）依旧开放——本轮的预览单飞修掉了**量**的问题，`!important` 状态层收口是工程解；若 Chromium 侧有解释值得跟进。
2. MCP 卡片可考虑加连接健康探测（当前「可启停」是启停态不是健康态）——需要服务端探针，另立波次。
3. 60MB 视频壁纸上限 64MB 已贴近，超过即拒绝——LO 若要更大视频需先解决传输/内存预算（暂不动作）。

__DELTA__: 烛(Claude) | 2 | 证据：app.js renderGlobalWallpaperPreview 每次渲染 requestBlob 全量拉字节且零缓存——冷启动水合重放 14 个外观 apply = 14 个并发 60MB GET（fetch 调用栈逐条取证），v8.5 修的水合竞态只是「水合没回填」，本条是「回填后被旁路消费者打爆」的独立第二层；单飞共享后 15→1 次、挂载 5.3s→0.9s
__DELTA__: 烛(Claude) | 1 | 证据：forge/data.css .cap-map flex 容器内 .cap-map-grid 子项收缩到内容宽（359px），三列映射网格恒为单列——flex-wrap 容器里的 grid 子项必须显式 flex-basis 撑满
