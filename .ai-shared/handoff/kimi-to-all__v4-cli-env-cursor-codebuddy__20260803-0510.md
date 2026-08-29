# 环境面板扩编 Cursor + CodeBuddy 波（Kimi → all）

> 时间：2026-08-03 · 主驾：Kimi · 范围：apps/control-center（src/cli-env.mjs / public/modules/ccswitch-panel.js / public/styles.css / tests/cli-env.test.mjs / scripts/qa-cli-env-probe.mjs）
> 触发：LO「添加cursor和codebuddy」（承接本地 CLI 环境面板波，清单 9 → 11）

## 一、实证先行（版本源性质两家完全不同）

- **CodeBuddy = npm 正路**：官方 CLI `@tencent-ai/codebuddy-code`（官方文档 codebuddy.cn/docs/cli/installation + npm packument 实证；bin `codebuddy` 含别名 cbc/codebuddy-code；latest 2.132.0）——探测/版本源/安装与既有 npm 工具同路径。
- **Cursor = 无 npm 官方包**：npm `cursor-agent@1.0.3` 系第三方 "Jacky" 占位、`@cursor/cursor-agent` 404（均实测）。官方分发走 `cursor.com/install` **版本钉住脚本**——当前钉 `2026.07.23-e383d2b`，版本标记内嵌 `downloads.cursor.com/lab/<版本>/<os>/<arch>/` 下载路径；且脚本只发 linux/darwin 包（win32 tarball HEAD 403、install.ps1 返回营销页，均实测）——**Windows 无官方一键安装路径**。

## 二、落地内容

- **新 registry 类 `script`**：fetch 官方脚本 text → `versionPattern` 正则解析最新版（失败同样降级 latestError 不装死）。
- **`installSpec(tool, platform)` 平台感知**：win32 → null；服务端 `install()` 前置硬闸 409 `CLI_ENV_UNSUPPORTED_PLATFORM`（确认过了也不伪造命令、不触子进程）；linux/darwin → 官方 `bash -c "curl -fsSL https://cursor.com/install | bash"`。
- **面板如实呈现**：`install:null` 时卡片 action 区换 `.ccs-cli-note` 说明（「Windows 无官方 CLI 安装包——由 Cursor IDE 自带 cursor-agent，或经 WSL 安装」），手动命令块同行无复制钮；「全部升级」过滤无安装路径工具；确认弹窗「来源」增「官方安装脚本」。两新成员无官方 sprite → lucide terminal（铁律不臆造品牌）。
- CodeBuddy 常规入列：`codebuddy --version` + npm dist-tags + `npm i -g @tencent-ai/codebuddy-code@latest`。

## 三、验证证据

- `tests/cli-env.test.mjs` 13 例全绿（新增 Cursor 用例：win32 闸 409 零子进程、linux bash argv + 装后 up-to-date、script 版本解析；契约 11 项 + script spec）；`npm test` 670 pass / 0 fail / 1 skipped。
- 探针扩编硬断言全过（`scripts/qa-cli-env-probe.mjs`）：11 卡渲染、Cursor 卡无假按钮+说明+latest `2026.07.23-e383d2b`、CodeBuddy 安装钮+npm 命令、手动块 11 行（Cursor 行为说明）复制钮 10、弹窗取消 install POST=0、控制台 0 错误；`.qa-v4/cli-env-light.png` 亲查（第四行 Cursor/CodeBuddy 就位）。

## 四、边界与回退

- 本波只进「环境检查/安装」面，**不是执行 Adapter 接入**——Cursor/CodeBuddy 席位化仍走 `proposals/multi-cli-adapter-eval.md` 四步路径（Cursor headless 有进程释放怪癖需超时兜底；CodeBuddy headless 资料稀缺先侦察）。
- Cursor 版本比较为日期数字核语义（2026.07.23 > 2026.06.15），sha 段不参与——展示级精度如实够用。
- 回退 = 还原 cli-env.mjs 清单/script registry/平台闸段、ccswitch-panel.js installNote 适配、styles.css ccs-cli-note、测试与探针本波段。

__DELTA__: Kimi | 1 | correctness | 证据：cli-env.mjs 新增 script registry + 平台感知 installSpec（win32 闸 409 零子进程实证）+ 探针硬断言 11 卡、Cursor 无假按钮+脚本版本解析、CodeBuddy npm 正路，npm test 670 pass 0 fail
