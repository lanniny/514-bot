# sync-codex-runtime.ps1 -- sync 514cc Codex sources into ~/.codex runtime.
#
# Direction: repository source -> Codex runtime.
# Default check mode reports drift only. Use -Apply to write runtime files.

param(
    [switch]$Apply,
    [string]$Repo = "I:\514claude\514cc",
    [string]$CodexHomePath = "",
    [ValidateSet("All", "Prompts")]
    [string]$Scope = "All"
)

$ErrorActionPreference = "Stop"
$repo = $Repo
$codexHome = if ([string]::IsNullOrWhiteSpace($CodexHomePath)) {
    Join-Path $env:USERPROFILE ".codex"
} else {
    $CodexHomePath
}
$backupRoot = Join-Path $codexHome "backups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $backupRoot "514cc-runtime-$stamp"

function Write-Utf8Atomically($path, $text) {
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $temporary = "$path.tmp-$([guid]::NewGuid().ToString('N'))"
    $previous = "$path.previous-$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($temporary, $text, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $path) {
            [IO.File]::Replace($temporary, $path, $previous)
        } else {
            [IO.File]::Move($temporary, $path)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $previous) {
            Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
        }
    }
}

$pairs = @(
    @{ n = "agent:default"; s = "$repo\.codex\agents\default.toml"; d = "$codexHome\agents\default.toml" },
    @{ n = "agent:codex-reviewer"; s = "$repo\.codex\agents\codex-reviewer.toml"; d = "$codexHome\agents\codex-reviewer.toml" },
    @{ n = "agent:grok-researcher"; s = "$repo\.codex\agents\grok-researcher.toml"; d = "$codexHome\agents\grok-researcher.toml" },
    @{ n = "agent:embedded-expert"; s = "$repo\.codex\agents\embedded-expert.toml"; d = "$codexHome\agents\embedded-expert.toml" },
    @{ n = "agent:spec-architect"; s = "$repo\.codex\agents\spec-architect.toml"; d = "$codexHome\agents\spec-architect.toml" },
    @{ n = "agent:meta-reviewer"; s = "$repo\.codex\agents\meta-reviewer.toml"; d = "$codexHome\agents\meta-reviewer.toml" },
    @{ n = "skill:514cc-collab"; s = "$repo\.agents\skills\514cc-collab"; d = "$codexHome\skills\514cc-collab" },
    @{ n = "skill:aemeath-persona"; s = "$repo\.agents\skills\aemeath-persona"; d = "$codexHome\skills\aemeath-persona" },
    @{ n = "skill:co-review"; s = "$repo\.agents\skills\co-review"; d = "$codexHome\skills\co-review" },
    @{ n = "skill:co-status"; s = "$repo\.agents\skills\co-status"; d = "$codexHome\skills\co-status" },
    @{ n = "skill:co-sync-codex"; s = "$repo\.agents\skills\co-sync-codex"; d = "$codexHome\skills\co-sync-codex" },
    @{ n = "skill:ultracode"; s = "$repo\.agents\skills\ultracode"; d = "$codexHome\skills\ultracode" },
    @{ n = "skill:lilith-core"; s = "$repo\.agents\skills\lilith-core"; d = "$codexHome\skills\lilith-core" }
)

if ($Scope -eq "Prompts") {
    $pairs = @($pairs | Where-Object { $_.n -like "agent:*" })
}

function Merge-GlobalAgents([switch]$Write) {
    $target = Join-Path $codexHome "AGENTS.md"
    $start = "<!-- >>> 514cc managed block -->"
    $end = "<!-- <<< 514cc managed block -->"
    $personaCorePath = Join-Path $repo ".codex\instructions\agents-persona-core.md"
    $globalCorePath = Join-Path $repo ".codex\instructions\global-agents-core.md"
    foreach ($source in @($personaCorePath, $globalCorePath)) {
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required instruction source is missing: $source"
        }
    }
    $personaCore = [IO.File]::ReadAllText($personaCorePath, [Text.UTF8Encoding]::new($false)).Trim()
    $globalCore = [IO.File]::ReadAllText($globalCorePath, [Text.UTF8Encoding]::new($false)).Trim()
    if ([string]::IsNullOrWhiteSpace($personaCore) -or [string]::IsNullOrWhiteSpace($globalCore)) {
        throw "Instruction sources must not be empty."
    }
    $current = if (Test-Path -LiteralPath $target) { [IO.File]::ReadAllText($target, [Text.UTF8Encoding]::new($false)) } else { "" }
    $newline = if ($current.Contains("`r`n")) { "`r`n" } else { "`n" }
    $template = @'
{{START}}

{{GLOBAL_CORE}}

{{PERSONA_CORE}}

For work in or for `I:/514claude/514cc`, read its project AGENTS.md for project-specific contracts. Do not load that project's governance for unrelated work.

{{END}}
'@
    $block = $template.Replace("{{START}}", $start).Replace("{{GLOBAL_CORE}}", $globalCore).Replace("{{PERSONA_CORE}}", $personaCore).Replace("{{END}}", $end).TrimEnd("`r", "`n")
    $block = [regex]::Replace($block, "\r\n|\r|\n", $newline)

    function Build-GlobalAgentsText([string]$text) {
        $startPattern = "(?m)^[ \t]*" + [regex]::Escape($start) + "[ \t]*\r?$"
        $endPattern = "(?m)^[ \t]*" + [regex]::Escape($end) + "[ \t]*\r?$"
        $startCount = [regex]::Matches($text, $startPattern).Count
        $endCount = [regex]::Matches($text, $endPattern).Count
        if ($startCount -ne $endCount -or $startCount -gt 1) {
            throw "Malformed 514cc AGENTS markers: start=$startCount end=$endCount."
        }
        if ($startCount -eq 1) {
            $pattern = "(?ms)^[ \t]*" + [regex]::Escape($start) + "[ \t]*\r?\n.*?^[ \t]*" + [regex]::Escape($end) + "[ \t]*(?:\r?\n|\z)"
            $matches = [regex]::Matches($text, $pattern)
            if ($matches.Count -ne 1) {
                throw "Could not isolate the existing 514cc AGENTS block."
            }
            return [regex]::Replace($text, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $block + $newline })
        }
        if ([string]::IsNullOrEmpty($text)) {
            return $block + $newline
        } elseif ($text.EndsWith($newline + $newline)) {
            return $text + $block + $newline
        } elseif ($text.EndsWith("`r`n") -or $text.EndsWith("`n")) {
            return $text + $newline + $block + $newline
        } else {
            return $text + $newline + $newline + $block + $newline
        }
    }
    $next = Build-GlobalAgentsText $current
    if ((Build-GlobalAgentsText $next) -cne $next) {
        throw "Global AGENTS merge is not byte-idempotent."
    }
    if ($next -cne $current) {
        if ($Write) {
            Write-Utf8Atomically $target $next
            Write-Host ("{0,-24} ok merged" -f "global-agents-block") -ForegroundColor Green
        } else {
            Write-Host ("{0,-24} != drift" -f "global-agents-block") -ForegroundColor Yellow
            return $false
        }
    } else {
        Write-Host ("{0,-24} = consistent" -f "global-agents-block") -ForegroundColor DarkGray
    }
    return $true
}

function Get-ContentHash($path) {
    # Line-ending-insensitive hash for text sources (.md/.toml): a CRLF-vs-LF difference is
    # a storage artifact, not a content drift. Without this, every text pair reports a
    # permanent false drift once one side is touched by a tool with different conventions.
    # Other extensions fall back to a raw byte hash so binary content stays exact.
    $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($ext -eq ".md" -or $ext -eq ".toml") {
        $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
        $normalized = ($text -replace "`r`n", "`n") -replace "`r", "`n"
        $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
        $sha = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "")
    }
    return (Get-ContentHash $path)
}
function Get-HashOrMissing($path) {
    if (-not (Test-Path -LiteralPath $path)) { return "<missing>" }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer) {
        $files = Get-ChildItem -LiteralPath $path -Recurse -File | Sort-Object FullName
        $material = foreach ($f in $files) {
            $rel = $f.FullName.Substring($item.FullName.Length)
            "$rel=$(Get-ContentHash $f.FullName)"
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes(($material -join "`n"))
        $sha = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "")
    }
    return (Get-ContentHash $path)
}

function Copy-Path($src, $dst) {
    $srcItem = Get-Item -LiteralPath $src
    $dstParent = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstParent)) {
        New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
    }
    $suffix = [guid]::NewGuid().ToString("N")
    $temporary = "$dst.tmp-$suffix"
    $previous = "$dst.previous-$suffix"
    if ($srcItem.PSIsContainer) {
        $movedPrevious = $false
        $installed = $false
        try {
            Copy-Item -LiteralPath $src -Destination $temporary -Recurse -Force
            if ((Get-HashOrMissing $src) -ne (Get-HashOrMissing $temporary)) {
                throw "Staged directory hash mismatch: $src"
            }
            if (Test-Path -LiteralPath $dst) {
                Move-Item -LiteralPath $dst -Destination $previous
                $movedPrevious = $true
            }
            try {
                Move-Item -LiteralPath $temporary -Destination $dst
                $installed = $true
            } catch {
                if ($movedPrevious -and -not (Test-Path -LiteralPath $dst)) {
                    Move-Item -LiteralPath $previous -Destination $dst
                    $movedPrevious = $false
                }
                throw
            }
        } finally {
            if (Test-Path -LiteralPath $temporary) {
                Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
            }
            if ($installed -and (Test-Path -LiteralPath $previous)) {
                Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        return
    }

    try {
        Copy-Item -LiteralPath $src -Destination $temporary -Force
        if ((Get-HashOrMissing $src) -ne (Get-HashOrMissing $temporary)) {
            throw "Staged file hash mismatch: $src"
        }
        if (Test-Path -LiteralPath $dst) {
            [IO.File]::Replace($temporary, $dst, $previous)
        } else {
            [IO.File]::Move($temporary, $dst)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $previous) {
            Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-TargetWritable($path) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $stream.Dispose()
    }

    $directory = Split-Path -Parent $path
    while (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory -PathType Container)) {
        $directory = Split-Path -Parent $directory
    }
    if ([string]::IsNullOrWhiteSpace($directory)) {
        throw "No writable ancestor found for target: $path"
    }
    $probe = Join-Path $directory (".514cc-write-probe-" + [guid]::NewGuid().ToString("N"))
    $renamed = "$probe-renamed"
    try {
        New-Item -ItemType Directory -Path $probe | Out-Null
        Move-Item -LiteralPath $probe -Destination $renamed
    } finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $renamed) { Remove-Item -LiteralPath $renamed -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function Merge-CodexConfig([switch]$Write) {
    $target = Join-Path $codexHome "config.toml"
    $sourceConfigPath = Join-Path $repo ".codex\config.toml"
    $mergeTool = Join-Path $repo "scripts\merge_codex_config.py"
    $python = (Get-Command python -ErrorAction Stop).Source
    $mode = if ($Write) { "--apply" } else { "--check" }
    $output = @(& $python $mergeTool --source $sourceConfigPath --target $target $mode 2>&1)
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) {
        Write-Host $line
    }
    if ($exitCode -eq 0) {
        return $true
    }
    if ((-not $Write) -and $exitCode -eq 1) {
        return $false
    }
    throw "Codex config merge failed with exit code $exitCode."
}

$drift = @()
$missingSources = @()
foreach ($p in $pairs) {
    if (-not (Test-Path -LiteralPath $p.s)) {
        Write-Host ("{0,-24} source missing: {1}" -f $p.n, $p.s) -ForegroundColor Red
        $drift += $p
        $missingSources += $p
        continue
    }
    $srcHash = Get-HashOrMissing $p.s
    $dstHash = Get-HashOrMissing $p.d
    if ($srcHash -eq $dstHash) {
        Write-Host ("{0,-24} = consistent" -f $p.n) -ForegroundColor DarkGray
    } else {
        Write-Host ("{0,-24} != drift" -f $p.n) -ForegroundColor Yellow
        $drift += $p
    }
}

if ($missingSources.Count -gt 0) {
    Write-Host "`nPreflight failed: $($missingSources.Count) source path(s) are missing. No runtime files were changed." -ForegroundColor Red
    exit 1
}

# Always build both merge candidates before the first write. In Apply mode, drift is
# expected; malformed markers or unsafe managed content still fail here.
$globalAgentsOk = Merge-GlobalAgents
$configOk = if ($Scope -eq "All") { Merge-CodexConfig } else { $true }

if (($drift.Count -eq 0) -and $globalAgentsOk -and $configOk) {
    Write-Host "`nAll Codex runtime mappings are consistent." -ForegroundColor Green
    exit 0
}

if (-not $Apply) {
    Write-Host "`nDrift detected. Re-run with -Apply to sync repository source -> Codex runtime." -ForegroundColor Yellow
    exit 1
}

$mergeTargets = @("$codexHome\AGENTS.md")
if ($Scope -eq "All") { $mergeTargets += "$codexHome\config.toml" }
foreach ($target in $mergeTargets + @($drift | ForEach-Object { $_.d })) {
    Assert-TargetWritable $target
}

New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($path in $mergeTargets) {
    if (Test-Path -LiteralPath $path) {
        Copy-Item -LiteralPath $path -Destination (Join-Path $backup (Split-Path -Leaf $path)) -Force
    }
}
foreach ($p in $drift) {
    if (Test-Path -LiteralPath $p.d) {
        $relative = $p.d.Substring($codexHome.TrimEnd('\').Length).TrimStart('\')
        $backupTarget = Join-Path $backup $relative
        $backupParent = Split-Path -Parent $backupTarget
        if (-not (Test-Path -LiteralPath $backupParent)) {
            New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
        }
        Copy-Item -LiteralPath $p.d -Destination $backupTarget -Recurse -Force
    }
}
Write-Host "Backup: $backup" -ForegroundColor Cyan

Merge-GlobalAgents -Write | Out-Null
if ($Scope -eq "All") { Merge-CodexConfig -Write | Out-Null }

$fail = 0
foreach ($p in $drift) {
    try {
        Copy-Path $p.s $p.d
        if ((Get-HashOrMissing $p.s) -eq (Get-HashOrMissing $p.d)) {
            Write-Host ("{0,-24} ok synced" -f $p.n) -ForegroundColor Green
        } else {
            Write-Host ("{0,-24} x post-check mismatch" -f $p.n) -ForegroundColor Red
            $fail++
        }
    } catch {
        Write-Host ("{0,-24} x {1}" -f $p.n, $_.Exception.Message) -ForegroundColor Red
        $fail++
    }
}

if ($fail -gt 0) {
    Write-Host "`n$fail item(s) failed." -ForegroundColor Red
    exit 1
}

Write-Host "`nCodex runtime sync complete. Restart Codex or start a new session to reload AGENTS, skills, agents, MCP, and hooks." -ForegroundColor Green
exit 0
