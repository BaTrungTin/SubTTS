# Cai PaddleOCR tren Python 3.11/3.12 (chinh xac hon EasyOCR; khong chay tren Python 3.14)
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MarkerFile = Join-Path $ProjectRoot "python_services\.ocr-python-path"

function Find-Python312 {
    foreach ($cmd in @("py -3.12", "py -3.11", "python3.12", "python3.11")) {
        try {
            $exe = Invoke-Expression "$cmd -c `"import sys; print(sys.executable)`"" 2>$null
            if ($exe -and (Test-Path $exe.Trim())) {
                $ver = Invoke-Expression "$cmd -c `"import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')`"" 2>$null
                if ($ver -match "^3\.(11|12)$") { return $exe.Trim() }
            }
        } catch {}
    }
    return $null
}

Write-Host "=== Cai PaddleOCR (Python 3.11/3.12) ===" -ForegroundColor Cyan
$py = Find-Python312
if (-not $py) {
    Write-Host ""
    Write-Host "Khong tim thay Python 3.11 hoac 3.12." -ForegroundColor Red
    Write-Host "Tai tu: https://www.python.org/downloads/release/python-3120/"
    Write-Host "Khi cai, bat 'Add python.exe to PATH' va 'py launcher'."
    Write-Host "Hoac: winget install Python.Python.3.12"
    exit 1
}

Write-Host "Dung Python: $py" -ForegroundColor Green
& $py -m pip install --upgrade pip
& $py -m pip install -r (Join-Path $ProjectRoot "python_services\requirements-paddle.txt")
# Paddle 3.x hay loi OneDNN tren Windows — ep ban 2.6.x
& $py -m pip install "paddlepaddle>=2.6.0,<3.0.0" --force-reinstall

Write-Host ""
Write-Host "Kiem tra PaddleOCR..."
& $py (Join-Path $ProjectRoot "python_services\detect_ocr_engine.py")

$py | Set-Content -Path $MarkerFile -Encoding utf8
Write-Host ""
Write-Host "Da luu duong dan Python cho app: $MarkerFile" -ForegroundColor Green
Write-Host "Restart: npm.cmd run dev"
Write-Host ""
Write-Host "Tuy chon GPU: $py -m pip install paddlepaddle-gpu" -ForegroundColor DarkGray
