param([ValidateSet('modelscope','huggingface')][string]$Source='modelscope')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
& '.\.venv\Scripts\python.exe' tools\download_model.py --source $Source
if ($LASTEXITCODE -ne 0) { throw '模型下载失败，可以重新执行继续下载。' }
