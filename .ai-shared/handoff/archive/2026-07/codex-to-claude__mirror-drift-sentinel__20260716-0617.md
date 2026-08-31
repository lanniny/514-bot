# Codex 独立评审：mirror-gate 双地落漂移哨兵

- **评审模式**：deep-review / adversarial
- **评审范围**：`.claude/hooks/mirror-gate.py`、`scripts/sync-runtime.ps1`
- **评审时间**：2026-07-16 06:17
- **Codex 模型**：gpt-5.6-sol（reasoning_effort=xhigh）
- **总 token**：138,780
- **机械验证**：隔离故障注入、两种卡片分支、真实 `check_drift()`、`sync-runtime.ps1` Check 模式

## 致命问题

1. **必须改：无法核验会被渲染成“一致”。** 仓库根解析异常直接返回空列表；单对的 `read_bytes()`、SHA-256 或权限异常也直接 `continue`，而空列表随后无条件显示为 `一致 ✓`。因此权限不足、读中途失败或 hash 异常都会产生假绿灯；隔离注入 `PermissionError` 的实测结果确为 `read_error=[]`。这不阻断会话，但违反哨兵的 Integrity Gate。必须把结果改成至少 `一致 / 漂移 / 无法核验` 三态，且部分失败不能吞掉其他对的已知结果。证据：`.claude/hooks/mirror-gate.py:133`、`.claude/hooks/mirror-gate.py:145`、`.claude/hooks/mirror-gate.py:151`、`.claude/hooks/mirror-gate.py:181`。

## 建议改进

1. **给推导出的 repo 根加身份校验。** `parents[2]` 在当前目录结构下正确，符号链接也会因 `resolve()` 回到真实目标；但文件若被复制/移动到其他同深度目录，它会静默监控另一个“repo”，而权威同步器仍硬编码 `I:\514claude\514cc`。建议核验固定锚点或明确的 repo marker；失败应报“无法核验”，不能报缺文件或一致。证据：`.claude/hooks/mirror-gate.py:134`、`scripts/sync-runtime.ps1:15`。
2. **区分“源缺失”和“运行时缺失”。** 当前两者统一写成 `name(缺文件)`，卡片又统一建议 `-Apply`；但同步器只能创建缺失的运行时目标，源缺失时会跳过并最终失败。建议输出 `源缺失 / 运行时缺失 / 读取失败`，给对应动作。证据：`.claude/hooks/mirror-gate.py:146`、`.claude/hooks/mirror-gate.py:184`、`scripts/sync-runtime.ps1:46`、`scripts/sync-runtime.ps1:75`。
3. **修复命令不应依赖当前 cwd。** hook 对任何路径含 `514claude` 的工作区生效，且会向上寻找各业务项目的 `.ai-shared`；卡片里的相对路径只在 514cc 仓库根下可靠。建议显示绝对仓库脚本路径，或给出先切换到 repo 根的完整 PowerShell 命令。证据：`.claude/hooks/mirror-gate.py:46`、`.claude/hooks/mirror-gate.py:184`、`.claude/hooks/mirror-gate.py:210`。
4. **保留“两对内联”设计，但加映射契约测试。** 不必让 SessionStart 解析 PowerShell，也不必为 2 对抽共享清单；应加一个离线回归断言，把内联的名称/源/目标与权威数组中的两项锁住，避免未来路径单边修改。证据：`.claude/hooks/mirror-gate.py:130`、`.claude/hooks/mirror-gate.py:138`、`scripts/sync-runtime.ps1:21`、`scripts/sync-runtime.ps1:40`。

## 可保留

1. **会话级 fail-open 完整，判决通过。** 路径推导和逐对读取均有局部兜底，`build_card()` 的调用处于 `main()` 外层 `try` 内，任何普通异常最终 `exit 0`；不存在本次新增逻辑把 SessionStart 阻断的路径。必须修的是“失败后假绿”，不是会话放行语义。证据：`.claude/hooks/mirror-gate.py:133`、`.claude/hooks/mirror-gate.py:145`、`.claude/hooks/mirror-gate.py:160`、`.claude/hooks/mirror-gate.py:205`、`.claude/hooks/mirror-gate.py:239`。
2. **两条映射与权威脚本完全一致。** `rules.md` 的源/目标分别为 repo 根和 `~/.ai-collab/rules.md`；output-style 的源/目标目录与文件名也逐段一致。真实 Check 模式同时报告 15/15 一致。证据：`.claude/hooks/mirror-gate.py:139`、`.claude/hooks/mirror-gate.py:140`、`scripts/sync-runtime.ps1:23`、`scripts/sync-runtime.ps1:40`。
3. **原始字节哈希口径正确。** Python 与 PowerShell 都做 SHA-256 字节比较；BOM、CRLF/LF 或编码只要改变字节就应被视为双地落漂移，这与“逐字拷贝”的同步契约一致。字节完全一致时不会因这些因素误报。证据：`.claude/hooks/mirror-gate.py:149`、`scripts/sync-runtime.ps1:47`、`scripts/sync-runtime.ps1:78`。
4. **同步性能与范围克制合理。** 新逻辑只读 4 个小文件、不拉子进程；当前真实调用约 1.9 ms。卡片也明确把状态限定为“宪法/人格”，没有冒充全 15 对健康检查，因此不要求抽共享运行时清单。证据：`.claude/hooks/mirror-gate.py:125`、`.claude/hooks/mirror-gate.py:130`、`.claude/hooks/mirror-gate.py:196`、`scripts/sync-runtime.ps1:21`。
5. **体检卡拼接无格式缺陷。** `verdict` 非空时自带前导换行；为空时下一段 f-string 提供唯一换行。漂移命令中的双反斜杠运行后为单反斜杠，JSON 序列化会正确转义。两分支实测均无粘连、空行或尾部错位。证据：`.claude/hooks/mirror-gate.py:184`、`.claude/hooks/mirror-gate.py:187`、`.claude/hooks/mirror-gate.py:191`、`.claude/hooks/mirror-gate.py:197`。

## 总评

设计方向成立：两对核心哨兵、同步执行、字节哈希、权威映射和卡片格式均正确，真实环境当前也是 15/15 一致；但异常被吞成空列表后渲染为“一致”是治理哨兵不能接受的可信性缺陷。修成三态并补权限/读取失败、错误 repo 根、源缺失、目标缺失四类回归后可复审。证据：`.claude/hooks/mirror-gate.py:125`、`.claude/hooks/mirror-gate.py:151`、`.claude/hooks/mirror-gate.py:181`、`scripts/sync-runtime.ps1:54`。

__VERDICT__: CHANGES_REQUESTED

__DELTA__: 烛(Codex) | 2 | 推翻“异常按对静默跳过仍可显示健康”的隐含判断：PermissionError 实测返回空列表并在 build_card 被渲染为 `一致 ✓`（mirror-gate.py:145-152,181-182）
