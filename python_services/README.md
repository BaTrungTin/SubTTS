# Trích xuất phụ đề từ video

App dùng **cùng hướng xử lý** như [timminator/VideOCR](https://github.com/timminator/VideOCR):

- Crop vùng phụ đề → giảm 720p  
- Bỏ frame giống nhau (SSIM)  
- **PaddleOCR** tiếng Trung (`ch`)  
- Gộp dòng + lọc trùng  

**Không** nhúng / clone repo VideOCR vào project — chỉ `pip install` PaddleOCR.

## Cài (một lần)

```powershell
pip install -r python_services\requirements.txt
```

Có GPU NVIDIA (nhanh hơn):

```powershell
pip install paddlepaddle-gpu
```

Sau đó restart `npm.cmd run dev`.

## Gợi ý

- Chế độ **Chính xác** trong app  
- Khung cyan **sát một dòng** phụ đề Trung  
