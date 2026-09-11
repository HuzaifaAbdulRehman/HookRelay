[CmdletBinding()]
param(
  [switch]$ResetTimeline
)

$ErrorActionPreference = 'Stop'

$hookRelayRoot = Split-Path -Parent $PSScriptRoot
$devonomaRoot = Join-Path (Split-Path -Parent $hookRelayRoot) 'Devonoma'
$stateDirectory = Join-Path $hookRelayRoot '.local'
$statePath = Join-Path $stateDirectory 'devonoma-flow.json'
$tunnelOutput = Join-Path $stateDirectory 'cloudflared.out.log'
$tunnelError = Join-Path $stateDirectory 'cloudflared.err.log'
$hookConfig = Join-Path $stateDirectory 'github-webhook.json'
$devonomaNextEnvironmentPath = Join-Path $devonomaRoot 'next-env.d.ts'

function Require-Command([string]$name) {
  if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name is required but was not found on PATH."
  }
}

function New-Secret {
  $bytes = [byte[]]::new(32)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Set-EnvValue([string]$path, [string]$name, [string]$value) {
  $lines = if (Test-Path $path) { @(Get-Content -LiteralPath $path) } else { @() }
  $pattern = "^$([regex]::Escape($name))="
  $updated = $false

  $next = foreach ($line in $lines) {
    if ($line -match $pattern) {
      $updated = $true
      "$name=$value"
    } else {
      $line
    }
  }

  if (-not $updated) {
    $next += "$name=$value"
  }

  Set-Content -LiteralPath $path -Value $next
}

function Wait-ForPort([int]$port, [string]$name) {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-NetConnection -ComputerName '127.0.0.1' -Port $port -InformationLevel Quiet) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "$name did not start on port $port."
}

function Install-Dependencies([string]$root) {
  $nodeModules = Join-Path $root 'node_modules'

  Push-Location $root
  try {
    if (Test-Path -LiteralPath $nodeModules) {
      & npm.cmd install --package-lock=false
    } else {
      & npm.cmd ci
    }

    if ($LASTEXITCODE -ne 0) {
      throw "Dependency installation failed in $root."
    }
  } finally {
    Pop-Location
  }
}

function Stop-RememberedProcess([int]$id) {
  if ($id -le 0) {
    return
  }

  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    Stop-Process -Id $id -Force
  }
}

Require-Command docker
Require-Command npm.cmd
Require-Command cloudflared
Require-Command gh

if (-not (Test-Path $devonomaRoot)) {
  throw "Devonoma was not found beside HookRelay at $devonomaRoot."
}

New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null

$hookEnv = Join-Path $hookRelayRoot '.env'
$devonomaEnv = Join-Path $devonomaRoot '.env.local'

if (-not (Test-Path $hookEnv)) {
  Copy-Item (Join-Path $hookRelayRoot '.env.example') $hookEnv
}

if (-not (Test-Path $devonomaEnv)) {
  Copy-Item (Join-Path $devonomaRoot '.env.example') $devonomaEnv
}

$state = if (Test-Path $statePath) {
  Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
} else {
  [pscustomobject]@{
    apiKey = New-Secret
    signingSecret = New-Secret
    endpointId = $null
    githubHookId = $null
    hookRelayPid = 0
    devonomaPid = 0
    cloudflaredPid = 0
  }
}

Stop-RememberedProcess ([int]$state.hookRelayPid)
Stop-RememberedProcess ([int]$state.devonomaPid)
Stop-RememberedProcess ([int]$state.cloudflaredPid)

Set-EnvValue $hookEnv 'PORT' '3200'
Set-EnvValue $hookEnv 'API_KEY' $state.apiKey
Set-EnvValue $hookEnv 'ALLOW_PRIVATE_DESTINATIONS' 'true'
Set-EnvValue $devonomaEnv 'DATABASE_URL' 'postgres://devonoma:devonoma@localhost:5433/devonoma'
Set-EnvValue $devonomaEnv 'WEBHOOK_SECRET' $state.signingSecret

Push-Location $hookRelayRoot
try {
  Install-Dependencies $hookRelayRoot
  & docker compose up -d --wait
  if ($LASTEXITCODE -ne 0) { throw 'HookRelay containers did not start.' }
  & npm.cmd run migrate:up
  if ($LASTEXITCODE -ne 0) { throw 'HookRelay migration failed.' }
} finally {
  Pop-Location
}

Push-Location $devonomaRoot
$previousDatabaseUrl = $env:DATABASE_URL
try {
  $env:DATABASE_URL = 'postgres://devonoma:devonoma@localhost:5433/devonoma'
  Install-Dependencies $devonomaRoot
  & docker compose up -d --wait
  if ($LASTEXITCODE -ne 0) { throw 'Devonoma containers did not start.' }
  & npm.cmd run migrate
  if ($LASTEXITCODE -ne 0) { throw 'Devonoma migration failed.' }
  if ($ResetTimeline) {
    & docker exec devonoma-postgres psql -U devonoma -d devonoma -c 'TRUNCATE github_activities;'
    if ($LASTEXITCODE -ne 0) { throw 'Devonoma timeline reset failed.' }
  }
} finally {
  if ($null -eq $previousDatabaseUrl) {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  } else {
    $env:DATABASE_URL = $previousDatabaseUrl
  }
  Pop-Location
}

$hookRelay = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory $hookRelayRoot -WindowStyle Hidden -PassThru
$state.hookRelayPid = $hookRelay.Id

Wait-ForPort 3200 'HookRelay'

if ([string]::IsNullOrWhiteSpace($state.endpointId)) {
  $headers = @{ Authorization = "Bearer $($state.apiKey)"; 'Content-Type' = 'application/json' }
  $body = @{ name = 'devonoma-local'; destinationUrl = 'http://127.0.0.1:3100/api/webhooks/hookrelay' } | ConvertTo-Json
  $endpoint = Invoke-RestMethod 'http://127.0.0.1:3200/endpoints' -Method Post -Headers $headers -Body $body
  $state.endpointId = $endpoint.id
  $state.signingSecret = $endpoint.signingSecret
  Set-EnvValue $devonomaEnv 'WEBHOOK_SECRET' $state.signingSecret
}

$devonomaNextEnvironment = if (Test-Path -LiteralPath $devonomaNextEnvironmentPath) {
  [System.IO.File]::ReadAllText($devonomaNextEnvironmentPath)
} else {
  $null
}

$devonoma = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev', '--', '--hostname', '127.0.0.1', '--port', '3100' -WorkingDirectory $devonomaRoot -WindowStyle Hidden -PassThru
$state.devonomaPid = $devonoma.Id
Wait-ForPort 3100 'Devonoma'

if ($null -ne $devonomaNextEnvironment) {
  [System.IO.File]::WriteAllText($devonomaNextEnvironmentPath, $devonomaNextEnvironment)
}

Remove-Item -LiteralPath $tunnelOutput, $tunnelError -Force -ErrorAction SilentlyContinue
$cloudflared = Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:3200', '--no-autoupdate' -RedirectStandardOutput $tunnelOutput -RedirectStandardError $tunnelError -WindowStyle Hidden -PassThru
$state.cloudflaredPid = $cloudflared.Id

$tunnelUrl = $null
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  $log = (Get-Content -LiteralPath $tunnelOutput, $tunnelError -Raw -ErrorAction SilentlyContinue) -join "`n"
  $match = [regex]::Match($log, 'https://[-a-z0-9]+\.trycloudflare\.com')
  if ($match.Success) {
    $tunnelUrl = $match.Value
    break
  }
  Start-Sleep -Milliseconds 500
}

if ($null -eq $tunnelUrl) {
  throw 'Cloudflare did not provide a temporary tunnel URL.'
}

$remote = (& git -C $devonomaRoot remote get-url origin).Trim()
$repository = ($remote -replace '^.*github\.com[:/]', '' -replace '\.git$', '')
if ([string]::IsNullOrWhiteSpace($repository)) {
  throw 'Could not determine the Devonoma GitHub repository from origin.'
}

$payloadUrl = "$tunnelUrl/hook/$($state.endpointId)"
$webhook = @{
  name = 'web'
  active = $true
  events = @('push')
  config = @{
    url = $payloadUrl
    content_type = 'json'
    secret = $state.signingSecret
  }
} | ConvertTo-Json -Depth 4

Set-Content -LiteralPath $hookConfig -Value $webhook
try {
  if ([string]::IsNullOrWhiteSpace($state.githubHookId)) {
    $created = & gh api --method POST "repos/$repository/hooks" --input $hookConfig | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'GitHub webhook creation failed.' }
    $state.githubHookId = $created.id
  } else {
    & gh api --method PATCH "repos/$repository/hooks/$($state.githubHookId)" --input $hookConfig | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub webhook update failed.' }
  }
} finally {
  Remove-Item -LiteralPath $hookConfig -Force -ErrorAction SilentlyContinue
}

$state | ConvertTo-Json | Set-Content -LiteralPath $statePath

Write-Host 'Local GitHub -> HookRelay -> Devonoma flow is running.' -ForegroundColor Green
Write-Host 'HookRelay dashboard: http://127.0.0.1:3200/dashboard'
Write-Host 'Devonoma timeline:    http://127.0.0.1:3100'
Write-Host 'Push any commit to Devonoma to verify the flow.'
