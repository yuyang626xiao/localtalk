# LocalTalk sidecar setup, plain-venv fallback (NO conda). ASCII-only source.
# Creates New/sidecar/.venv (CPython 3.11/3.12 - the sokuji_native wheels are
# built for those) and installs requirements.txt, including the prebuilt
# sokuji_native win_amd64 wheel from Sokuji GitHub releases (no C++ build).
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Find-Python {
  $cands = @(
    @{ exe = 'py';         pre = @('-3.12') },
    @{ exe = 'py';         pre = @('-3.11') },
    @{ exe = 'python3.12'; pre = @() },
    @{ exe = 'python3.11'; pre = @() },
    @{ exe = 'python';     pre = @() },
    @{ exe = 'python3';    pre = @() }
  )
  foreach ($c in $cands) {
    if (-not (Get-Command $c.exe -ErrorAction SilentlyContinue)) { continue }
    $v = & $c.exe @($c.pre + @('-c', 'import sys;print("%d.%d" % sys.version_info[:2])')) 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $v) { continue }
    $ver = New-Object Version ($v.ToString().Trim())
    if ($ver -ge [Version]'3.11' -and $ver -lt [Version]'3.13') {
      return @{ exe = $c.exe; pre = @($c.pre) }
    }
  }
  return $null
}

if (-not (Test-Path .venv)) {
  $found = Find-Python
  if (-not $found) {
    Write-Host '[setup] no usable Python 3.11/3.12 found. Install Python 3.12 (winget install Python.Python.3.12) or use setup-conda.ps1.'
    exit 1
  }
  Write-Host "[setup] creating .venv with $($found.exe) $($found.pre -join ' ')"
  & $found.exe @($found.pre + @('-m', 'venv', '.venv'))
  if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
}

$py = Join-Path .venv 'Scripts\python.exe'
Write-Host '[setup] pip install -r requirements.txt (downloads sokuji_native wheel from GitHub Releases) ...'
& $py -m pip install --upgrade pip -q
& $py -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'dependency install failed (GitHub slow? use a proxy or install the wheel manually)' }

& $py -c "import sokuji_native; print('[setup] sokuji_native import OK')"
Write-Host '[setup] done. Now: cd ..\app ; npm install ; npm run dev'
Write-Host '[hint]  China network: set HF_ENDPOINT=https://hf-mirror.com before launching the app for model downloads.'
