[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$hookRelayRoot = Split-Path -Parent $PSScriptRoot
$devonomaRoot = Join-Path (Split-Path -Parent $hookRelayRoot) 'Devonoma'
$statePath = Join-Path $hookRelayRoot '.local\devonoma-flow.json'

if (-not (Test-Path -LiteralPath $statePath)) {
  throw 'Local demo state is missing. Start the local flow first.'
}

if (-not (Test-Path -LiteralPath $devonomaRoot)) {
  throw "Devonoma was not found beside HookRelay at $devonomaRoot."
}

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($state.endpointId) -or [string]::IsNullOrWhiteSpace($state.signingSecret)) {
  throw 'Local demo state is incomplete. Start the local flow again.'
}

$previousIngestUrl = $env:HOOKRELAY_INGEST_URL
$previousWebhookSecret = $env:WEBHOOK_SECRET

try {
  $env:HOOKRELAY_INGEST_URL = "http://127.0.0.1:3200/hook/$($state.endpointId)"
  $env:WEBHOOK_SECRET = $state.signingSecret

  Push-Location $devonomaRoot
  try {
    & npm.cmd run demo:push
    if ($LASTEXITCODE -ne 0) { throw 'Local demo push failed.' }
  } finally {
    Pop-Location
  }
} finally {
  if ($null -eq $previousIngestUrl) {
    Remove-Item Env:HOOKRELAY_INGEST_URL -ErrorAction SilentlyContinue
  } else {
    $env:HOOKRELAY_INGEST_URL = $previousIngestUrl
  }

  if ($null -eq $previousWebhookSecret) {
    Remove-Item Env:WEBHOOK_SECRET -ErrorAction SilentlyContinue
  } else {
    $env:WEBHOOK_SECRET = $previousWebhookSecret
  }
}
