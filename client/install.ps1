# Alveare installer for Windows (PowerShell 5.1+).
#   From GitHub:  irm https://raw.githubusercontent.com/AGHEORONO/alveare/main/client/install.ps1 | iex
#   From a hive:  & ([scriptblock]::Create((irm http://HOST:4747/install.ps1))) HOST:4747 JOINCODE
# With HOST and JOINCODE it also joins that hive from the current directory (your project repo).
param([string]$HiveHost = '', [string]$Code = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'AGHEORONO/alveare'
$asset = 'alveare-windows-x64.exe'
$base = if ($env:ALVEARE_HOME) { $env:ALVEARE_HOME } else { Join-Path $env:USERPROFILE '.alveare' }
$dir = Join-Path $base 'bin'
$exe = Join-Path $dir 'alveare.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path $dir 'alveare.download'

$got = $false
if ($HiveHost) {
  Write-Host "-> downloading $asset from the hive at $HiveHost"
  try { Invoke-WebRequest -UseBasicParsing "http://$HiveHost/download/$asset" -OutFile $tmp; $got = $true } catch { }
}
if (-not $got) {
  Write-Host "-> downloading $asset from GitHub releases"
  Invoke-WebRequest -UseBasicParsing "https://github.com/$repo/releases/latest/download/$asset" -OutFile $tmp
}
Move-Item -Force $tmp $exe
Unblock-File $exe
Write-Host "OK installed $exe ($(& $exe version))"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $dir), 'User')
  Write-Host "OK added $dir to your PATH (open a new terminal to use 'alveare' everywhere)"
}
$env:Path = "$env:Path;$dir"

if ($HiveHost -and $Code) {
  Write-Host ''
  & $exe join $HiveHost --code $Code
}
