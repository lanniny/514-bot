# Composer v2：CLI 语义对齐 + 附件（2026-07-19）

LO 六点反馈全落：①/effort 折叠下拉（去"默认"伪选项，档位 low/medium/high/xhigh/**ultracode**——headless 实测 CLI 接受 --effort ultracode，默认 high）②权限 Plan/Build 折叠下拉③"需要当前资料"删除、换 ➕ 附件（服务端 OpenFileDialog 多选 → chips → 路径并入 prompt，续聊同样可用）④发送键锚定最右（spacer+auto-margin 双保险，窄屏换行仍贴右）⑤/model 已是具体模型 ID⑥胶囊整体打磨。

## ultracode workflow 双路验证（2 agent 并行，228k tokens）

- **ui-walkthrough**：5 组通过（结构/档位/双模式/暗色对比度/双视口无溢出）+ P1 叠印 + P2×3
- **code-adversarial**：7 组通过（XSS 零漏网/残留引用零命中/锁语义/白名单/附件生命周期）+ **P1 GBK 码页**（powershell stdout OEM 码页×UTF-8 解码=中文路径全坏，pick-directory 存量同病）+ P2×3

## 修复回合

- GBK：两个 picker 脚本钉 `[Console]::OutputEncoding=UTF8`，node spawn 实测中文完整
- 叠印：composer-hint 绝对悬浮 → 文档流右对齐（叠印+误触热区同灭，实测零重叠）
- statusFor 补 PROCESS_TIMEOUT→408 / OUTPUT_LIMIT→413；pick-file 输出上限 256KB；previewRoute 与提交同文本；注释勘误
- 存疑排除：agent 报"常驻橙红描边"实测静止态为中性沙（其焦点观测偏差）
- 未采纳留档：withAttachments 注入面（本地单用户特权面 + Windows 路径无换行锁死列表行内，接受现状）；乱码历史会话（坏数据非本批引入，清除已结束任务即消）

测试 112/112。

__DELTA__: workflow双agent(ui+code) | 2 | code agent 独有发现 GBK 码页缺陷（server.mjs picker 全部中文路径静默失效，含 pick-directory 存量）推翻主驾"附件链路已可用"判断；ui agent 独有发现 hint 叠印误触（textarea 首行 vs +新任务热区）
