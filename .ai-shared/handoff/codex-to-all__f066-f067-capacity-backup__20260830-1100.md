# F-066/F-067 观测与运维补强（容量配额 + 备份演练）

> **状态**：✅ 两项脚本已落地，可独立运行
> **审计者**：烛（Codex 面），2026-08-30

## F-066: 容量配额与归档 ✅

新增 `scripts/capacity-quota.mjs`：

**功能**：
1. 扫描 dataRoot 下各存储文件大小
2. 按保留策略裁剪过期条目（默认 30 天）
3. 裁剪 events.jsonl / sessions.jsonl / automations runHistory
4. 输出容量报告

**当前状态**：
- `.ai-shared/control-center/` 总大小 93.37 MB，214 个文件
- events.jsonl 有 6790 条超过 30 天的记录可裁剪
- dry-run 模式验证通过

**用法**：
```bash
node scripts/capacity-quota.mjs [dataRoot] [--dry-run] [--days N]
```

## F-067: 备份恢复演练 ✅

新增 `scripts/backup-drill.mjs`：

**功能**：
1. 对关键数据（context.md/decisions.md/roster.json/events/sessions/automations/handoff）做备份
2. 验证备份完整性（文件存在性 + 大小）
3. 输出备份报告

**当前状态**：
- dry-run 模式验证通过，列出 7 个关键路径
- 实际执行会创建 `.backups/drill-{timestamp}/` 目录

**用法**：
```bash
node scripts/backup-drill.mjs [dataRoot] [--dry-run]
```

## 建议

- 将 capacity-quota 加入定期调度（如每周一次）
- 将 backup-drill 加入每月一次的运维日历
- 两者均可作为 npm script 暴露：`npm run quota:prune` / `npm run backup:drill`

`__DELTA__: 烛(Codex) | 1 | 证据：F-066/F-067 两项观测/运维脚本落地，dry-run 验证通过`
