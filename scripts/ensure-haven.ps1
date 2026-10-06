$ErrorActionPreference = 'SilentlyContinue'
$havenDir = Split-Path $PSScriptRoot -Parent
$dataDir = if ($env:HAVEN_DATA_DIR) { $env:HAVEN_DATA_DIR } else { Join-Path $env:APPDATA 'Haven-AmniScient' }
$envFile = Join-Path $dataDir '.env'
$port = 3010
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
  if ($line) { $port = [int]($line -split '=')[1] }
}
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 3
  if ($r.StatusCode -eq 200) { Write-Host "haven already up on :$port"; exit 0 }
} catch {}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'node not found'; exit 1 }
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
$log = Join-Path $havenDir 'backups\ensure-haven.log'
Add-Content -Path $log -Value ("{0} ensure-haven spawn port={1}" -f (Get-Date -Format o), $port)
$env:HAVEN_DATA_DIR = $dataDir
$env:FORCE_HTTP = 'true'
$p = Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $havenDir -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
try {
  $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
  if ($r2.StatusCode -eq 200) { Write-Host "haven up on :$port pid=$($p.Id)"; exit 0 }
} catch {}
if ($p -and -not $p.HasExited) { Write-Host "haven process pid=$($p.Id) started (health pending)"; exit 0 }
Write-Error "haven failed - process exited early (check port $port / logs)"
exit 1
