# aidlc-dashboard launcher — Windows (PowerShell).
#
# Run from a terminal:
#
#     .\start.ps1
#     .\start.ps1 C:\path\to\workspace
#     .\start.ps1 --port 5000 --poll 0
#
# If Windows blocks this file ("running scripts is disabled on this system" — a
# fresh install refuses unsigned .ps1), run start.cmd instead: it calls this with
# -ExecutionPolicy Bypass for that one invocation and changes no machine setting.
#
# WHY THIS EXISTS RATHER THAN JUST `bun run src/server.ts`:
#   1. bun installs to %USERPROFILE%\.bun\bin, which is on PATH only for shells
#      that have read the user profile. We probe the known locations too.
#   2. First run needs `bun install`.
#   3. The browser should open by itself, and only once the port answers.

param(
  # Everything is forwarded to the server; a bare first argument is treated as the
  # workspace path so --root can be omitted.
  #
  # ⚠️ NOT named $Args: `$args` is a PowerShell AUTOMATIC variable (see
  # about_Automatic_Variables), so declaring a parameter by that name collides
  # with the engine's own. Also no [CmdletBinding()] here — an advanced function
  # parses `--port` as a malformed parameter name and fails before the script body
  # runs; a plain param block passes the tokens through verbatim.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Passthru
)

$ErrorActionPreference = 'Stop'

# Run from the script's own directory so relative paths hold no matter where the
# script was invoked from.
Set-Location -LiteralPath $PSScriptRoot

function Find-Bun {
  # PATH first (a terminal run), then the documented install locations.
  $onPath = Get-Command bun -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $candidates = @(
    (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'),
    'C:\Program Files\bun\bun.exe'
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

$bun = Find-Bun
if (-not $bun) {
  Write-Host ''
  Write-Host '✗ bun 을 찾지 못했다.' -ForegroundColor Red
  Write-Host ''
  Write-Host 'AI-DLC 는 bun 이 필수다. PowerShell 에서 설치:'
  Write-Host '    powershell -c "irm bun.sh/install.ps1 | iex"' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '설치 후 터미널을 새로 열고 다시 실행한다.'
  Write-Host ''
  # No Read-Host: exiting non-zero is enough for a terminal run, and prompting
  # would block a caller that just wants the exit status.
  exit 1
}

$bunVersion = (& $bun --version).Trim()
Write-Host "> bun $bunVersion ($bun)"

# ---- dependencies -----------------------------------------------------------
if (-not (Test-Path -LiteralPath 'node_modules')) {
  Write-Host '> 의존성 설치 (최초 1회)...'
  & $bun install
  if ($LASTEXITCODE -ne 0) { throw 'bun install 실패' }
}

# ---- arguments --------------------------------------------------------------
$serverArgs = @()
$rest = @($Passthru | Where-Object { $_ -ne $null -and $_ -ne '' })

# A bare first argument is the workspace path.
if ($rest.Count -gt 0 -and -not $rest[0].StartsWith('-')) {
  $serverArgs += '--root'
  $serverArgs += $rest[0]
  $rest = @($rest | Select-Object -Skip 1)
}
$serverArgs += $rest

# Read the port back out so the browser opens the right URL.
$port = 4321
for ($i = 0; $i -lt $serverArgs.Count; $i++) {
  if ($serverArgs[$i] -eq '--port' -and ($i + 1) -lt $serverArgs.Count) {
    $port = $serverArgs[$i + 1]
  }
}
$url = "http://localhost:$port"

# ---- open the browser once the port answers ---------------------------------
# A background job, because the server has to start before there is anything to
# open. Polling beats a fixed sleep — a cold start is fast, a big audit log is not.
$opener = Start-Job -ScriptBlock {
  param($u)
  for ($n = 0; $n -lt 40; $n++) {   # ~10s ceiling
    try {
      Invoke-WebRequest -Uri "$u/healthz" -TimeoutSec 1 -UseBasicParsing | Out-Null
      Start-Process $u
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
} -ArgumentList $url

Write-Host "> $url  (Ctrl+C 로 종료)"
Write-Host ''

try {
  & $bun run src/server.ts @serverArgs
} finally {
  # Do not leave the poller behind if the server exits early.
  Remove-Job -Job $opener -Force -ErrorAction SilentlyContinue
}
