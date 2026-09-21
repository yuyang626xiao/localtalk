param([string]$EnvName = 'localtalk')
# LocalTalk sidecar setup on a CONDA machine (Windows). ASCII-only: Windows
# PowerShell 5.1 misreads BOM-less UTF-8. See New/README.md for details.
#   powershell -ExecutionPolicy Bypass -File .\setup-conda.ps1 [-EnvName localtalk]
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ---- locate conda --------------------------------------------------------------
$conda = $env:CONDA_EXE
if (-not $conda -or -not (Test-Path $conda)) { $conda = $null }
if (-not $conda) {
  $cands = @(
    "$env:USERPROFILE\Miniforge3\Scripts\conda.exe",
    "$env:USERPROFILE\miniconda3\Scripts\conda.exe",
    "$env:USERPROFILE\anaconda3\Scripts\conda.exe",
    'C:\ProgramData\miniconda3\Scripts\conda.exe',
    'C:\ProgramData\anaconda3\Scripts\conda.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c) { $conda = $c; break } }
}
if (-not $conda) {
  $w = (Get-Command conda -ErrorAction SilentlyContinue)
  if ($w) { $conda = $w.Source }
}
if (-not $conda) { Write-Host '[setup] conda not found'; exit 1 }
$condaRoot = Split-Path (Split-Path $conda)          # ...\Miniforge3
Write-Host "[setup] conda: $conda"

# ---- create env if missing (python 3.12: the sokuji_native wheels are cp312) ---
$envPython = Join-Path $condaRoot "envs\$EnvName\python.exe"
if (-not (Test-Path $envPython)) {
  Write-Host "[setup] conda create -n $EnvName python=3.12 ..."
  & $conda create -y -n $EnvName 'python=3.12'
  if ($LASTEXITCODE -ne 0) { throw 'conda create failed (slow network? add a conda-forge mirror first)' }
}
& $envPython --version

# ---- install requirements (includes the prebuilt sokuji_native win wheel) ------
Write-Host '[setup] pip install -r requirements.txt (downloads sokuji_native wheel from GitHub Releases) ...'
& $envPython -m pip install --upgrade pip -q
& $envPython -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'pip install failed (GitHub slow/blocked? use a proxy, or grab the wheel from the sokuji native-v1.1.0 release manually)' }

# ---- record for the Electron host ----------------------------------------------
Set-Content -Path (Join-Path $PSScriptRoot '.python-path') -Value $envPython -NoNewline
Write-Host "[setup] wrote .python-path -> $envPython"
& $envPython -c "import sokuji_native; print('[setup] sokuji_native import OK')"
Write-Host '[setup] done. Now: cd ..\app ; npm install ; npm run dev'
