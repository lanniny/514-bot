# 项目插件

项目插件中心位于 `#plugins`，Bot 会话头的插件图标打开当前项目的工具、工作流与面板。安装和启用分开：安装后选择项目、启用并保存参数。归档项目允许停用；仍有项目启用时拒绝卸载。

目录与已安装列表都可打开详情抽屉。目录态展示清单、能力与包信息，但配置保持只读；安装后选择项目，抽屉可同时设置项目启停和清单参数。桌宠伴侣的全部设置只在该插件详情中提供，Control Center 会先从服务端插件台账确认已安装，再允许本地悬浮窗或网页挂件启动；旧的本地设置不能绕过安装状态。

本版支持 `514cc.plugin/v1` 声明式 JSON 包。工作流生成当前对话草稿，由用户发送后进入原 Conversation/Run 准入；工具读取当前项目或运行摘要；面板使用宿主结构化组件。安装不修改用户 CLI 目录，不加载插件 JavaScript、shell、MCP 进程、远程页面或安装脚本。

```json
{
  "schema": "514cc.plugin/v1",
  "id": "quality-check",
  "name": "质量检查",
  "version": "1.0.0",
  "description": "按项目目标准备质量审查。",
  "settings": [
    { "id": "focus", "label": "重点", "type": "string", "default": "正确性与回归" }
  ],
  "tools": [
    { "id": "context", "name": "读取项目概要", "kind": "project-summary" }
  ],
  "workflows": [
    { "id": "review", "name": "准备审查", "prompt": "核对项目 {{project.title}}。审查重点：{{config.focus}}。给出文件和验证证据。" }
  ],
  "panels": [
    { "id": "activity", "name": "最近运行", "source": "run-summary" }
  ]
}
```

字段边界：ID 为小写字母开头的字母/数字/连字符，最多 64 字符；版本为三段数字。settings 支持 string、boolean、number、select，select 需要 options。工具 kind 和面板 source 仅支持 project-summary、run-summary。工作流引用仅允许 `project.title` 和已定义的 `config.<id>`。不支持的字段、贡献与类型会拒绝。

包文件上限 128 KiB；最多 100 个安装项、5000 条项目绑定，总台账 2 MiB。内置目录 ID 为宿主保留标识，只能从目录安装，自定义导入不能用同名清单替换。当前版本升级流程为先逐项目停用、卸载再导入新版本；没有原地升级或远程商店协议。

服务端 `ProjectPluginStore` 持有 `${dataRoot}/project-plugins.json`，以 revision 比较和进程内队列串行化原子替换。文件损坏或摘要不匹配时拒绝读写，原文件保留。它不提供多实例写锁。API 沿用控制面 Bearer 鉴权和 observer 写入限制。

新 Run 从持久化 Conversation 的 Project 得到插件快照，记录版本、digest 和参数。配置变化不改写已有 Run。直接工具调用每次重新检查当前项目启用状态，停用后立即拒绝新调用。快照不等于原生模型工具注册或模型执行证据。

验证入口：`node --test tests/project-plugins.test.mjs tests/skill-recovery.test.mjs`；真实浏览器：`node scripts/qa-project-plugins.mjs --output-dir=<目录>`。加 `--serve` 启动独立预览，provider 禁用，全部数据位于临时目录。
