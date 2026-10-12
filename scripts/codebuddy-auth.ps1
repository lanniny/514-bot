<#
.SYNOPSIS
    514cc CodeBuddy 认证与 API 管理工具

.DESCRIPTION
    用于管理腾讯 CodeBuddy Code CLI 在 514cc 体系中的登录态、API 密钥与连通性检查。

.PARAMETER Login
    拉起交互式终端，触发网页 OAuth / 扫码登录。

.PARAMETER Status
    检查当前的安装状态、登录态、环境变量与连通性（默认操作）。

.PARAMETER SetApiKey
    设置 CODEBUDDY_API_KEY 环境变量（永久写入用户级环境变量）。

.PARAMETER ClearApiKey
    清除 CODEBUDDY_API_KEY 环境变量，切回网页 OAuth 模式。

.PARAMETER Test
    发起一次非交互式连通性测试（PING）。

.EXAMPLE
    .\scripts\codebuddy-auth.ps1 -Status
    .\scripts\codebuddy-auth.ps1 -Login
    .\scripts\codebuddy-auth.ps1 -SetApiKey "your-api-key"
    .\scripts\codebuddy-auth.ps1 -ClearApiKey
#>

[CmdletBinding()]
param(
    [switch]$Login,
    [switch]$Status,
    [string]$SetApiKey,
    [switch]$ClearApiKey,
    [switch]$Test
)

$ErrorActionPreference = "Stop"

function Mask-Secret([string]$Secret) {
    if ([string]::IsNullOrWhiteSpace($Secret)) { return "<none>" }
    if ($Secret.Length -le 8) { return "••••" }
    return $Secret.Substring(0, 3) + "••••" + $Secret.Substring($Secret.Length - 4)
}

function Find-CodebuddyCmd {
    $cmd = Get-Command codebuddy.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command codebuddy -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = "C:\Dprogress\nodejs\node_global\codebuddy.cmd"
    if (Test-Path $fallback) { return $fallback }
    return $null
}

$codebuddyExe = Find-CodebuddyCmd

if ($SetApiKey) {
    Write-Host "[514cc] 正在设置 CODEBUDDY_API_KEY..." -ForegroundColor Cyan
    [Environment]::SetEnvironmentVariable("CODEBUDDY_API_KEY", $SetApiKey, "User")
    $env:CODEBUDDY_API_KEY = $SetApiKey
    Write-Host "[514cc] 成功：已将 CODEBUDDY_API_KEY 写入用户级环境变量并同步到当前会话。" -ForegroundColor Green
    Write-Host "[514cc] 凭据掩码: $(Mask-Secret $SetApiKey)" -ForegroundColor DarkGray
    Write-Host "[514cc] 提示：Control Center 后续调用将自动继承该 API Key。" -ForegroundColor Yellow
    exit 0
}

if ($ClearApiKey) {
    Write-Host "[514cc] 正在清除 CODEBUDDY_API_KEY..." -ForegroundColor Cyan
    [Environment]::SetEnvironmentVariable("CODEBUDDY_API_KEY", $null, "User")
    Remove-Item env:\CODEBUDDY_API_KEY -ErrorAction SilentlyContinue
    Write-Host "[514cc] 成功：已清除 CODEBUDDY_API_KEY 环境变量。" -ForegroundColor Green
    Write-Host "[514cc] 提示：CodeBuddy 将切回 ~/.codebuddy 本地会话与网页 OAuth 登录态。" -ForegroundColor Yellow
    exit 0
}

if ($Login) {
    if (-not $codebuddyExe) {
        Write-Host "[514cc] 错误：未找到 codebuddy 可执行文件。请先全局安装：npm install -g @tencent-ai/codebuddy-code" -ForegroundColor Red
        exit 1
    }
    Write-Host "[514cc] 正在拉起交互式 CodeBuddy 终端进行登录..." -ForegroundColor Cyan
    Write-Host "[514cc] 提示：如果未登录，CLI 会在浏览器中打开登录链接或显示二维码。" -ForegroundColor DarkGray
    Write-Host "[514cc] 提示：如果已登录，可在进入后输入 /logout 退出，或输入 /login 重新登录。" -ForegroundColor DarkGray
    Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
    & $codebuddyExe
    Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "[514cc] 交互进程已退出。正在复检状态..." -ForegroundColor Cyan
    & $PSCommandPath -Status
    exit 0
}

# 默认或 -Status / -Test
Write-Host "=== 514cc CodeBuddy 认证与环境状态 ===" -ForegroundColor Cyan

# 1. 检查 CLI 安装
if ($codebuddyExe) {
    Write-Host "  CLI 路径      : $codebuddyExe" -ForegroundColor Green
    try {
        $version = & $codebuddyExe --version 2>$null
        Write-Host "  CLI 版本      : $version" -ForegroundColor Green
    } catch {
        Write-Host "  CLI 版本      : 获取失败 ($($_))" -ForegroundColor Yellow
    }
} else {
    Write-Host "  CLI 路径      : 未检测到 codebuddy，请检查 PATH 或全局安装" -ForegroundColor Red
}

# 2. 检查环境变量
$apiKeyEnv = $env:CODEBUDDY_API_KEY
$userApiKey = [Environment]::GetEnvironmentVariable("CODEBUDDY_API_KEY", "User")
$authTokenEnv = $env:CODEBUDDY_AUTH_TOKEN

Write-Host "  会话 API Key  : $(Mask-Secret $apiKeyEnv)" -ForegroundColor $(if ($apiKeyEnv) { "Green" } else { "DarkGray" })
Write-Host "  用户 API Key  : $(Mask-Secret $userApiKey)" -ForegroundColor $(if ($userApiKey) { "Green" } else { "DarkGray" })
Write-Host "  AUTH TOKEN    : $(Mask-Secret $authTokenEnv)" -ForegroundColor $(if ($authTokenEnv) { "Green" } else { "DarkGray" })

# 3. 检查本地会话目录 (~/.codebuddy)
$cbHome = Join-Path $env:USERPROFILE ".codebuddy"
if (Test-Path $cbHome) {
    Write-Host "  本地状态目录  : $cbHome (存在)" -ForegroundColor Green
    $settingsFile = Join-Path $cbHome "settings.json"
    if (Test-Path $settingsFile) {
        Write-Host "  本地设置文件  : settings.json (存在)" -ForegroundColor Green
    }
} else {
    Write-Host "  本地状态目录  : $cbHome (尚未生成，首次登录后创建)" -ForegroundColor Yellow
}

# 4. 项目内配置路径提示
$modelsConfig = "config\control-center\models.json"
$headlessConfig = "config\control-center\codebuddy-headless-settings.json"
Write-Host "  项目席位配置  : $modelsConfig" -ForegroundColor DarkGray
Write-Host "  无头环境配置  : $headlessConfig" -ForegroundColor DarkGray

# 5. 连通性测试
if ($Test -or (-not $Login -and -not $SetApiKey -and -not $ClearApiKey)) {
    Write-Host "`n[连通性测试] 正在向 CodeBuddy 发起非交互式探测 (PING)..." -ForegroundColor Cyan
    try {
        $pingResult = & $codebuddyExe -p --output-format text "PING" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  测试结果      : 正常响应 (ExitCode: 0)" -ForegroundColor Green
            Write-Host "  响应摘要      : $($pingResult | Select-Object -First 3 | Out-String)" -ForegroundColor DarkGray
        } else {
            Write-Host "  测试结果      : 异常 (ExitCode: $LASTEXITCODE)" -ForegroundColor Yellow
            Write-Host "  错误信息      : $($pingResult | Out-String)" -ForegroundColor Red
            Write-Host "  建议          : 运行 .\scripts\codebuddy-auth.ps1 -Login 进行登录授权" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  测试结果      : 执行异常 ($($_))" -ForegroundColor Red
    }
}

Write-Host "`n常用管理命令:" -ForegroundColor Cyan
Write-Host "  登录 / 扫码   : .\scripts\codebuddy-auth.ps1 -Login" -ForegroundColor DarkGray
Write-Host "  设置 API Key  : .\scripts\codebuddy-auth.ps1 -SetApiKey 'your-api-key'" -ForegroundColor DarkGray
Write-Host "  清除 API Key  : .\scripts\codebuddy-auth.ps1 -ClearApiKey" -ForegroundColor DarkGray
Write-Host "  仅连通性测试 : .\scripts\codebuddy-auth.ps1 -Test" -ForegroundColor DarkGray
