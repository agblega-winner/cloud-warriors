$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pkiDir = Join-Path $projectRoot "pki"

if (-not (Test-Path $pkiDir)) {
    New-Item -Path $pkiDir -ItemType Directory | Out-Null
}

$nodes = @("node-a", "node-b")

foreach ($node in $nodes) {
    $keyPath = Join-Path $pkiDir "${node}_ed25519"

    if (Test-Path $keyPath) {
        Write-Output "SKIP: $keyPath already exists"
        continue
    }

    ssh-keygen -t ed25519 -a 64 -N "" -C "$node@archipel" -f $keyPath | Out-Null
    Write-Output "OK: generated $keyPath"
}

Write-Output "Done. Keys are in: $pkiDir"
