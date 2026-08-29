<!-- 514cc-session-id: 019ff87a-5528-7192-8ed0-ee23821eb8b5 -->
# Codex 供应商配置收口

## 结果

- Codex 新建供应商预设固定为 `自定义配置 / OpenAI Official / Azure OpenAI / Micu`，顺序固定；其他应用仍保留各自目录。
- `OpenAI Official` 是固定置顶的虚拟官方登录行：不能排序、编辑、复制、删除或另存为重复档案；无论新写入还是旧 `providers.json` 恢复，后端都执行同一保留名不变量。
- Codex 配置字段按参考图收口在同一弹窗：名称、备注、官网、API Key、API 请求地址、完整 URL、默认模型；高级选项作为基本页内 `<details>` 折叠，包含上游格式、推理强度、模型映射、User-Agent、Header/Body 覆盖，没有独立高级页。
- 点击哪个应用标签下的“新增供应商”，新档案就只启用该应用；编辑旧档案仍保留既有应用关联。
- 供应商方案和相关默认批量操作不再显示或触碰 Claude Desktop；后端存储、历史档案、旧团队绑定和显式 legacy 调用仍兼容。

## 安全与一致性补强

- `apps/control-center/server.mjs:1231`：编辑档案复用旧 API Key 前严格比较 URL origin；跨来源返回 `PROVIDER_CREDENTIAL_SCOPE_MISMATCH`，不会发出模型请求。
- `apps/control-center/src/ccswitch/proxy.mjs:352`：Codex `meta.isFullUrl=true` 时完整 URL 原样转发，不重复追加 `/responses`。
- `apps/control-center/src/providers.mjs:2495`：raw Codex TOML 与 `514-forge-model-catalog.json` 同事务生成/清理；引用受管目录但无模型映射时返回 `CODEX_MODEL_CATALOG_REQUIRED`。
- `apps/control-center/src/ccswitch/domain.mjs:683`、`:779`、`:849`、`:1377`：Profile、恢复、批量 live 重写和远端下载默认只处理 `PROVIDER_SCHEME_APPS`，显式传 `claude-desktop` 仍兼容。
- `apps/control-center/src/providers.mjs:562`：只有 `auth_mode=chatgpt` 且有字符串 token material 才识别为 Codex OAuth。
- `apps/control-center/src/providers.mjs:86`、`:1184`：OpenAI Official 保留名同时覆盖 CRUD/import 与持久化恢复；严格匹配旧版 Codex API Key 形状的正常档案只在内存中安全改名为 `OpenAI API Key (Legacy)`，保留 ID、Key 和排序，但不恢复 current/failover/autoFailover，`init()` 不改真实文件。自定义 URL、模型映射、raw config、额外应用、执行性 meta 或未知字段的同名记录仍进入 `blocked / PROVIDER_STORE_CORRUPT`。
- `apps/control-center/src/providers.mjs:55`、`:73`、`:1906`：持久化和导入在迁移前统一拒绝重复/非法 Provider ID，并保留前端 `app::providerId(::direction)` 协议所需的 `::` 与尾冒号边界；内部单冒号 ID 继续可用。

## UI 证据

- `apps/control-center/public/app.js:8046`：OpenAI Official 固定虚拟行；`app.js:9391`：Codex 四预设白名单和排序；`app.js:9556`：Official 预设禁保存。
- `apps/control-center/public/app.js:8587`：弹窗目标应用只由当前顶部应用标签决定。
- `apps/control-center/public/index.html:2424`：高级选项为基本面板内折叠区；`public/styles.css:11728`、`:11759`：Codex 桌面/移动弹窗响应式布局。
- Playwright 真实验收通过：桌面 `1440x1000`、移动 `390x844`；两端预设均严格为四项，Official 首行且操作按钮数为 0，高级折叠位于 basic 面板，旧 tabs 隐藏，Claude Desktop 不可见，缺失图标/页面错误/控制台错误/阻断响应/请求失败均为 0，document/dialog/form/body 横向溢出均为 0。
- 最终截图位于 `C:/Users/16643/.codex/visualizations/2026/08/13/019ff87a-5528-7192-8ed0-ee23821eb8b5/`：`codex-provider-list-{desktop,mobile}.png` 与 `codex-provider-dialog-{desktop,mobile}-{collapsed,expanded}.png`。
- 隔离 QA 服务使用 `.tmp/provider-config-closeout/`，经 `/api/test/shutdown` 正常 `exit 0`；最终 `127.0.0.1:50437` 无监听、无 QA lock。

## 测试与复审

- `npm run validate`：13/13 valid，真实退出码 0。
- `node --check` 与 `git diff --check`：通过；仅有既有 LF/CRLF 提示。
- 最终精确反例回归：7 tests / 7 pass / 0 fail；完整 `providers.test.mjs`：68 / 68 pass；`provider-dialog-target-app.test.mjs`：10 / 10 pass。
- 最终六文件联合回归：162 tests / 162 pass / 0 fail，TAP 断言耗时约 6.63 秒。Node 22.12 仍在汇总后保留既有句柄，最终由 120 秒外层超时终止；断言结果可信，但不得描述成干净 `exit 0`。
- 上一轮完整回归：1067 tests / 1066 pass / 0 fail / 1 skip，断言耗时约 36.5 秒；同样存在 TAP 汇总后不退出的既有句柄问题。
- 真实 `.ai-shared/control-center/providers.json` 只读加载为 `ready`：21 个档案、1 个 legacy 兼容迁移，Key 存在但未输出，迁移记录不在 current/failover 中且 Codex 排序保留；加载前后 SHA-256 均为 `C31E687BE1CE3873BC0106ABE9D5A257AEF3D973872346368C09B25B3DAC07B0`。
- 独立审查先推翻原收口判断并关闭 6 个安全/一致性问题，随后针对 legacy 恢复又发现重复 ID 身份错配、双冒号截断与尾冒号排序冲突。最终第四轮复审结论为 `ACCEPT`；穷举 19,607 个短 ID 后，6,951 个合法 ID 在切换/排序动作协议中均无损往返，0 个失败。

## 工作区边界

- 未 commit、未 push、未 reset/checkout，未清理未知改动。
- 交付包含 21 个已跟踪修改文件、本 handoff，以及 `.tmp/provider-config-closeout/` 下的隔离 QA 运行产物；最终必须以 `git status --short --untracked-files=all` 为准。
- `.tmp/provider-config-closeout/` 新增的 `.claude.json`、Claude project JSONL 和 Kimi native worker 均由隔离 HOME/APPDATA 的运行时启动探测产生，不在真实用户 HOME；本轮保留现场，没有擅自删除。

__DELTA__: 烛(Codex) | 2 | architecture | 证据：apps/control-center/server.mjs:1231 与 apps/control-center/src/providers.mjs:86 关闭了独立审查推翻原收口判断后发现的凭据跨来源外发、legacy Official 误冻结和 Provider ID 动作协议冲突
