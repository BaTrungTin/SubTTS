# Trích xuất phụ đề từ video

App dùng **cùng hướng xử lý** như [timminator/VideOCR](https://github.com/timminator/VideOCR):

- Crop vùng phụ đề → giảm 720p  
- Bỏ frame giống nhau (SSIM)  
- **EasyOCR** tiếng Trung (`ch_sim`) — mặc định, chạy trên Python 3.14  
- Hoặc **PaddleOCR** nếu đã cài `paddlepaddle` (Python 3.11–3.12)  
- Gộp dòng + lọc trùng  

**Không** nhúng / clone repo VideOCR vào project.

## Cài (một lần)

```powershell
pip install -r python_services\requirements.txt
```

Tuỳ chọn PaddleOCR (Python 3.11–3.12 + GPU):

```powershell
pip install paddleocr paddlepaddle-gpu
```

Sau đó restart `npm.cmd run dev`.

## Gợi ý

- Chế độ **Chính xác** trong app  
- Khung cyan **sát một dòng** phụ đề Trung  
