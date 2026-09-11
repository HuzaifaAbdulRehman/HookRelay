[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$hookRelayRoot = Split-Path -Parent $PSScriptRoot
$devonomaRoot = Join-Path (Split-Path -Parent $hookRelayRoot) 'Devonoma'
$statePath = Join-Path $hookRelayRoot '.local\devonoma-flow.json'

function Stop-RememberedProcess([int]$id) {
  if ($id -le 0) {
    return
  }

  if ($null -ne (Get-Process -Id $id -ErrorAction SilentlyContinue)) {
    & taskkill.exe /PID $id /T /F | Out-Null
  }
}

if (Test-Path -LiteralPath $statePath) {
  $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  Stop-RememberedProcess ([int]$state.hookRelayPid)
  Stop-RememberedProcess ([int]$state.devonomaPid)
  Stop-RememberedProcess ([int]$state.cloudflaredPid)
}

Push-Location $hookRelayRoot
try {
  & docker compose stop
  if ($LASTEXITCODE -ne 0) { throw 'HookRelay Docker containers did not stop.' }
} finally {
  Pop-Location
}

if (Test-Path -LiteralPath $devonomaRoot) {
  Push-Location $devonomaRoot
  try {
    & docker compose stop
    if ($LASTEXITCODE -ne 0) { throw 'Devonoma Docker containers did not stop.' }
  } finally {
    Pop-Location
  }
}

Write-Host 'Local HookRelay and Devonoma demo services stopped.'
