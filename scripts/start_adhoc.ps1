param(
  [int]$HttpPort = 3000,
  [int]$NodePort = 7777,
  [string]$IdentityFile = "identity-adhoc.json",
  [switch]$EnableAi
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "=== ARCHIPEL MODE AD-HOC (SANS INTERNET) ===" -ForegroundColor Cyan
Write-Host "HTTP/UI : $HttpPort"
Write-Host "TCP Node: $NodePort"
Write-Host "Identity: $IdentityFile"

$env:PORT = "$HttpPort"
$env:ARCHIPEL_IDENTITY_PATH = $IdentityFile

if ($EnableAi) {
  Write-Host "AI activee uniquement si GEMINI_API_KEY est configuree." -ForegroundColor Yellow
  node app.js $NodePort
} else {
  Write-Host "AI desactivee (--no-ai) pour garantir zero trafic Internet." -ForegroundColor Green
  node app.js $NodePort --no-ai
}
