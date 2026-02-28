param(
  [string]$LocalApi = "http://localhost:3000",
  [string]$PeerApis = "",
  [string]$TestFile = "C:\Users\DELL\bureau\archipel-h24-test\archipel-h24\test50mo.bin",
  [string]$RemoteOutput = "C:\Temp\archipel_recu.bin"
)

$ErrorActionPreference = "Stop"

function Convert-ApiToHostPort {
  param([string]$ApiUrl)
  $uri = [Uri]$ApiUrl
  $hostName = $uri.Host
  $port = if ($uri.IsDefaultPort) { if ($uri.Scheme -eq 'https') { 443 } else { 80 } } else { $uri.Port }
  return [PSCustomObject]@{ Host = $hostName; Port = $port }
}

function Invoke-Api {
  param(
    [string]$Base,
    [string]$Path,
    [string]$Method = "GET",
    $Body = $null
  )

  $uri = "$Base$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri
  }

  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 8)
}

Write-Host "=== ARCHIPEL TEST MULTI-PC (Sprint 1/2/3 + API) ===" -ForegroundColor Cyan
Write-Host "Local API: $LocalApi"

$localStatus = Invoke-Api -Base $LocalApi -Path "/api/status"
$localIdentity = $localStatus.identity
if (-not $localIdentity -or -not $localIdentity.nodeId) {
  throw "Impossible de lire l'identite locale via /api/status"
}

Write-Host "Node local: $($localIdentity.nodeId)" -ForegroundColor Green

$peerApisList = @()
if ($PeerApis.Trim().Length -gt 0) {
  $peerApisList = $PeerApis.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
}

if ($peerApisList.Count -eq 0) {
  Write-Host "Aucun peer distant fourni. Test local de base uniquement." -ForegroundColor Yellow
  $localPeers = Invoke-Api -Base $LocalApi -Path "/api/peers"
  Write-Host "Peers locaux: $($localPeers.Count)"
  exit 0
}

$peersInfo = @()
foreach ($peerApi in $peerApisList) {
  Write-Host "\n--- Lecture status peer: $peerApi ---" -ForegroundColor Cyan
  $peerStatus = Invoke-Api -Base $peerApi -Path "/api/status"
  $peerIdentity = $peerStatus.identity
  if (-not $peerIdentity -or -not $peerIdentity.nodeId -or -not $peerIdentity.publicKey) {
    throw "Le peer $peerApi ne retourne pas identity.nodeId/publicKey"
  }

  $hostPort = Convert-ApiToHostPort -ApiUrl $peerApi
  $peersInfo += [PSCustomObject]@{
    Api = $peerApi
    NodeId = $peerIdentity.nodeId
    PublicKey = $peerIdentity.publicKey
    TcpPort = [int]$peerStatus.nodePort
    ApiHost = $hostPort.Host
    ApiPort = [int]$hostPort.Port
  }

  Write-Host "Peer nodeId: $($peerIdentity.nodeId)" -ForegroundColor Green
}

Write-Host "\n=== Etape 1: Enregistrement croise des pairs ===" -ForegroundColor Cyan

foreach ($peer in $peersInfo) {
  Invoke-Api -Base $LocalApi -Path "/api/peers" -Method "POST" -Body @{
    nodeId = $peer.NodeId
    ip = $peer.ApiHost
    port = $peer.TcpPort
    apiPort = $peer.ApiPort
    publicKey = $peer.PublicKey
    note = "peer distant"
  } | Out-Null

  $localHostPort = Convert-ApiToHostPort -ApiUrl $LocalApi
  Invoke-Api -Base $peer.Api -Path "/api/peers" -Method "POST" -Body @{
    nodeId = $localIdentity.nodeId
    ip = $localHostPort.Host
    port = [int]$localStatus.nodePort
    apiPort = [int]$localHostPort.Port
    publicKey = $localIdentity.publicKey
    note = "pair local"
  } | Out-Null

  Write-Host "Pair croise OK: $($peer.NodeId)" -ForegroundColor Green
}

Write-Host "\n=== Etape 2: Test messagerie chiffree inter-PC ===" -ForegroundColor Cyan
$firstPeer = $peersInfo[0]
$msgText = "Test inter-PC $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$send = Invoke-Api -Base $LocalApi -Path "/api/send-message" -Method "POST" -Body @{
  peerId = $firstPeer.NodeId
  content = $msgText
}

Write-Host "Message envoye: $($send.message.id) | delivery=$($send.message.delivery)" -ForegroundColor Green
Start-Sleep -Seconds 1
$peerMessages = Invoke-Api -Base $firstPeer.Api -Path "/api/messages"
$seen = $peerMessages | Where-Object { $_.from -eq $localIdentity.nodeId -and $_.content -eq $msgText }
if (-not $seen) {
  throw "Le peer distant n'a pas recu le message inter-PC"
}
Write-Host "Reception distante OK" -ForegroundColor Green

Write-Host "\n=== Etape 3: Test transfert fichier inter-PC ===" -ForegroundColor Cyan
if (-not (Test-Path $TestFile)) {
  throw "Fichier test absent: $TestFile"
}

Invoke-Api -Base $LocalApi -Path "/api/start-transfer-server" -Method "POST" | Out-Null
Invoke-Api -Base $firstPeer.Api -Path "/api/start-transfer-server" -Method "POST" | Out-Null

$transfer = Invoke-Api -Base $LocalApi -Path "/api/transfer" -Method "POST" -Body @{
  filePath = $TestFile
  peerId = $firstPeer.NodeId
}

$fileId = $transfer.manifest.file_id
Write-Host "Manifest cree: $fileId" -ForegroundColor Green

$download = Invoke-Api -Base $firstPeer.Api -Path "/api/download" -Method "POST" -Body @{
  peerId = $localIdentity.nodeId
  fileId = $fileId
  outputPath = $RemoteOutput
}

Write-Host "Telechargement distant termine: $($download.transfer.status)" -ForegroundColor Green

Write-Host "\n=== Etape 4: Verification finale ===" -ForegroundColor Cyan
$localFinal = Invoke-Api -Base $LocalApi -Path "/api/status"
$peerFinal = Invoke-Api -Base $firstPeer.Api -Path "/api/status"
Write-Host "Local -> peers:$($localFinal.peers.Count) messages:$($localFinal.messages) transferts:$($localFinal.transfers)"
Write-Host "Peer  -> peers:$($peerFinal.peers.Count) messages:$($peerFinal.messages) transferts:$($peerFinal.transfers)"

Write-Host "\nSUCCES: validation multi-PC terminee." -ForegroundColor Green
