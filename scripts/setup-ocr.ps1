# Cai PaddleOCR cho trich xuat phu de (khong clone repo VideOCR)
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
Write-Host "Cai Python packages..."
python -m pip install --upgrade pip
python -m pip install -r python_services\requirements.txt
Write-Host ""
python -c "from paddleocr import PaddleOCR; print('PaddleOCR OK')"
Write-Host ""
Write-Host "Xong. Chay: npm.cmd run dev"
