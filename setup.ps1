param([ValidateSet('CUDA','CPU')][string]$Backend='CUDA', [string]$Python='python')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
if (!(Test-Path '.venv\Scripts\python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw '需要可用的 Python 3.11/3.12。示例：.\setup.ps1 -Python C:\Python312\python.exe' }
}
$pythonExe=Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$torchIndex=if ($Backend -eq 'CPU') {'https://download.pytorch.org/whl/cpu'} else {'https://download.pytorch.org/whl/cu126'}
$wheel=Join-Path $PSScriptRoot '.downloads\torch-2.7.1+cu126-cp312-cp312-win_amd64.whl'
if ($Backend -eq 'CUDA' -and (Test-Path $wheel)) {
    & $pythonExe -m pip install --no-cache-dir --timeout 120 $wheel torchaudio==2.7.1 --index-url $torchIndex
} else {
    & $pythonExe -m pip install --no-cache-dir --timeout 120 torch==2.7.1 torchaudio==2.7.1 --index-url $torchIndex
}
if ($LASTEXITCODE -ne 0) { throw 'PyTorch 安装失败' }
$dependencyFile=if(Test-Path 'requirements.lock.txt'){'requirements.lock.txt'}else{'requirements.txt'}
& $pythonExe -m pip install --no-cache-dir --timeout 120 -r $dependencyFile
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
Write-Host '安装完成。下一步：.\download-model.ps1，然后 .\start.ps1'
