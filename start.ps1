param([int]$Port=8766, [ValidateSet('auto','cuda','cpu')][string]$Device='auto', [ValidateSet('auto','bfloat16','float16','float32')][string]$Precision='auto', [ValidateSet('auto','fast','torch')][string]$Backend='auto', [switch]$SkipWarmup, [switch]$Lan)
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$pythonExe=Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (!(Test-Path $pythonExe)) { throw '请先运行 setup.ps1 安装依赖。' }
try {
    $ttsExisting=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 2
    if ($ttsExisting.model -eq 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice') {
        Write-Host "服务已经运行：http://127.0.0.1:$Port。切换 CPU/CUDA 或局域网模式前请先运行 stop.cmd。"
        return
    }
} catch { }
$env:TTS_DEVICE=$Device
$env:TTS_PRECISION=$Precision
$env:TTS_BACKEND=$Backend
$env:TTS_PRELOAD=if($SkipWarmup){'0'}else{'1'}
Write-Host "Qwen TTS Lab: http://127.0.0.1:$Port （此终端关闭后服务停止）"
$listenAddress=if($Lan){'0.0.0.0'}else{'127.0.0.1'}
& $pythonExe -m uvicorn app:app --host $listenAddress --port $Port --workers 1
