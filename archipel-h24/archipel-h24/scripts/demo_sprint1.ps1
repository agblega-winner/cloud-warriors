$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$root`"; node run_node.js --tcp-port 7777 --hello-interval 5 --stale-timeout 20"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$root`"; node run_node.js --tcp-port 7778 --hello-interval 5 --stale-timeout 20"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$root`"; node run_node.js --tcp-port 7779 --hello-interval 5 --stale-timeout 20"

Write-Output "Started 3 nodes (ports 7777/7778/7779)."
