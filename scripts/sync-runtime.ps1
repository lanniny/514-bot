# sync-runtime.ps1 — 514cc 双地落一键同步（D-2026-05-23-002 拖欠 3 年的债，2026-06-11 兑现）
#
# 方向：仓库源 → 运行时（单向，源是唯一真相）
# 用法：
#   .\sync-runtime.ps1            # Check 模式：只报漂移不写盘；exit 0=全一致 / 1=有漂移
#   .\sync-runtime.ps1 -Apply     # 同步漂移项（源→运行时）并复检
#
# 不在映射表里的双地落：
#   .claude/hooks/{route-gate,stop-gate}.py —— 全局 settings.json 用绝对路径引用仓库内单份，
#   无运行时副本，设计上免疫漂移（v3.2 经验：能单份就别拷贝）。

param([switch]$Apply)

# 退出码契约三分（Check 模式）：0=全一致 / 1=有漂移或缺失（正常业务结果）/ 2=脚本自身执行异常
# Apply 模式的 1 还含"同步后复检失败/源缺失"（79-87 行显式 exit 1）；Console drift() 只走 Check
# （无 trap 时 PS 未捕获异常也走 exit 1，会与"有漂移"混淆）
trap { Write-Host "sync-runtime internal error: $_" -ForegroundColor Red; exit 2 }

$ErrorActionPreference = "Stop"
$repo = "I:\514claude\514cc"
$home_ = $env:USERPROFILE
$backupRoot = Join-Path $repo ".ai-shared\backups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $backupRoot "claude-runtime-$stamp"

$pairs = @(
    # -- 宪法 --
    @{n = "rules.md";       s = "$repo\rules.md";                                        d = "$home_\.ai-collab\rules.md" },
    # -- 5 命名 Agent（SKILL.md 逐字拷贝为运行时 agent） --
    @{n = "agent:codex";    s = "$repo\skills\review\codex-reviewer\SKILL.md";           d = "$home_\.claude\agents\codex-reviewer.md" },
    @{n = "agent:grok";     s = "$repo\skills\research\grok-researcher\SKILL.md";        d = "$home_\.claude\agents\grok-researcher.md" },
    @{n = "agent:embedded"; s = "$repo\skills\domain\embedded-expert\SKILL.md";          d = "$home_\.claude\agents\embedded-expert.md" },
    @{n = "agent:spec";     s = "$repo\skills\domain\spec-architect\SKILL.md";           d = "$home_\.claude\agents\spec-architect.md" },
    @{n = "agent:meta";     s = "$repo\skills\meta\meta-reviewer\SKILL.md";              d = "$home_\.claude\agents\meta-reviewer.md" },
    # -- 7 个 /co-* 命令（SKILL.md 逐字拷贝为运行时 command，2026-06-11 hash 对账确认映射） --
    @{n = "co-auto";        s = "$repo\skills\orchestration\auto-pilot\SKILL.md";        d = "$home_\.claude\commands\co-auto.md" },
    @{n = "co-enhance";     s = "$repo\skills\orchestration\enhance\SKILL.md";           d = "$home_\.claude\commands\co-enhance.md" },
    @{n = "co-status";      s = "$repo\skills\utility\status\SKILL.md";                  d = "$home_\.claude\commands\co-status.md" },
    @{n = "co-init";        s = "$repo\skills\utility\init\SKILL.md";                    d = "$home_\.claude\commands\co-init.md" },
    @{n = "co-archive";     s = "$repo\skills\utility\archive\SKILL.md";                 d = "$home_\.claude\commands\co-archive.md" },
    @{n = "co-review";      s = "$repo\skills\review\codex-reviewer\SKILL.md";           d = "$home_\.claude\commands\co-review.md" },
    @{n = "co-research";    s = "$repo\skills\research\grok-researcher\SKILL.md";        d = "$home_\.claude\commands\co-research.md" },
    # -- 状态栏 + 人格皮肤 --
    @{n = "ccline-theme";   s = "$repo\statusline\514cc.toml";                           d = "$home_\.claude\ccline\themes\514cc.toml" },
    @{n = "output-style";   s = "$repo\output-styles\aemeath-meta-butler.md";            d = "$home_\.claude\output-styles\aemeath-meta-butler.md" },
    # roxy-migurdia 2026-10-09 补入：此前 514cc/CLAUDE.md 双地落表列了这对，但 sync 对表漏登记，
    # 靠手工同步维持 diff=0——无哨兵守，改一处即静默漂移。
    @{n = "output-style:roxy"; s = "$repo\output-styles\roxy-migurdia.md";               d = "$home_\.claude\output-styles\roxy-migurdia.md" }
)

$drift = @()
foreach ($p in $pairs) {
    if (-not (Test-Path $p.s)) { Write-Host ("{0,-14} x source missing: {1}" -f $p.n, $p.s) -ForegroundColor Red; $drift += $p; continue }
    if (-not (Test-Path $p.d)) { Write-Host ("{0,-14} ! runtime missing (will create)" -f $p.n) -ForegroundColor Yellow; $drift += $p; continue }
    if ((Get-FileHash $p.s).Hash -ne (Get-FileHash $p.d).Hash) {
        Write-Host ("{0,-14} != drift" -f $p.n) -ForegroundColor Yellow; $drift += $p
    } else {
        Write-Host ("{0,-14} = consistent" -f $p.n) -ForegroundColor DarkGray
    }
}

if ($drift.Count -eq 0) { Write-Host "`nAll $($pairs.Count) runtime mappings are consistent." -ForegroundColor Green; exit 0 }

if (-not $Apply) {
    Write-Host "`n$($drift.Count) mapping(s) drifted. Run .\sync-runtime.ps1 -Apply to sync source -> runtime." -ForegroundColor Yellow
    exit 1
}

Write-Host "`nApply: syncing $($drift.Count) mapping(s) source -> runtime." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($p in $drift) {
    if (Test-Path -LiteralPath $p.d) {
        $relative = $p.d.Substring($home_.Length).TrimStart("\", "/")
        $backupPath = Join-Path $backup $relative
        $backupDir = Split-Path -Parent $backupPath
        if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
        Copy-Item -LiteralPath $p.d -Destination $backupPath -Force
    }
}
Write-Host "Backup: $backup" -ForegroundColor Cyan
$fail = 0
foreach ($p in $drift) {
    if (-not (Test-Path $p.s)) { Write-Host ("{0,-14} x skipped: source missing" -f $p.n) -ForegroundColor Red; $fail++; continue }
    $dstDir = Split-Path $p.d -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force $dstDir | Out-Null }
    Copy-Item $p.s $p.d -Force
    $ok = (Get-FileHash $p.s).Hash -eq (Get-FileHash $p.d).Hash
    if ($ok) { Write-Host ("{0,-14} ok synced and verified" -f $p.n) -ForegroundColor Green }
    else     { Write-Host ("{0,-14} x post-check mismatch" -f $p.n) -ForegroundColor Red; $fail++ }
}
if ($fail -gt 0) { Write-Host "`n$fail item(s) failed." -ForegroundColor Red; exit 1 }
Write-Host "`nRuntime sync complete. Restart Claude Code to reload agent/command changes." -ForegroundColor Green
exit 0
