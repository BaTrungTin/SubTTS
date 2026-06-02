# Walkthrough & User Guide - Vibe Studio Subtitle Tool

We have successfully built a **completely brand-new, clean-slate, high-performance** desktop application for Chinese video subtitle OCR extraction, Gemini-powered rotating translation, and hybrid text-to-speech lồng tiếng!

---

## 🌟 Key Capabilities Completed

1. **Draggable & Resizable Subtitle Cropbox**:
   - Implemented an elegant percentage-based overlay canvas `<SubtitleCropbox>` that handles visual boundary dragging.
   - Converts visual coordinates on the player to absolute video pixel values to feed the OCR reader.
2. **Python OCR Pipeline (OpenCV + EasyOCR)**:
   - Written a lightweight, high-performance `ocr_processor.py` that processes frames at optimal sampling intervals (5fps).
   - Utilizes character overlap calculations to merge contiguous timeline segments, producing standard `.srt` subtitles without external subtitle libraries.
3. **Gemini Multi-Key API Rotation**:
   - Integrated a key manager capable of holding a pool of Gemini keys.
   - Rotates to the next working key automatically upon hitting an HTTP `429` rate-limit or quota error, translating in 10-line context batches.
4. **CapCut-style 3-Voice Dubbing configurator**:
   - Designed a three-column interface supporting three independent voice engines.
   - Controls Volume, Pitch, Speed dynamically.
5. **Advanced FFmpeg Hybrid Dubbing Engine (Auto-Stretch)**:
   - **Chế độ 1 (Video Priority)**: Automatically speeds up speech clips that overrun their time bounds.
   - **Chế độ 2 (Hybrid Auto-Stretch)**: Splits the video, slows down the video segment using `-vf setpts` where the TTS voice is longer, merges everything back, and overlays audio clips perfectly synchronized with the newly stretched video track!

---

## 📂 Project Hierarchy

Our workspace is structured as follows:

```
d:\vibeCodeAppDichTiengTrung\
├── electron/
│   ├── main.ts              # Electron startup and IPC communication hub
│   ├── preload.ts           # Secure ContextBridge APIs
│   ├── RenderingManager.ts  # Dubbing coordinator
│   └── services/
│       ├── AudioEngine.ts   # FFmpeg mixing and auto-stretching algorithms
│       ├── GeminiTranslator.ts # Key rotation SRT translating service
│       └── TtsService.ts    # TTS voice speech downloader
├── python_services/
│   └── ocr_processor.py     # Python subtitle OCR crop extraction script
├── src/
│   ├── components/
│   │   ├── ui/
│   │   │   ├── Checkbox.tsx # Custom UI controls
│   │   │   ├── Select.tsx
│   │   │   └── Slider.tsx
│   │   └── SubtitleCropbox.tsx # Visual dragging cropbox canvas
│   ├── App.css
│   ├── App.tsx              # Master multi-tab sidebar dashboard panel
│   ├── constants.ts         # Voice models and synchronization modes metadata
│   ├── electron-api.ts      # TypeScript IPC context bridge definitions
│   ├── index.css            # Dark space cyberpunk styling tokens
│   └── main.tsx
├── package.json             # Scripts and packages metadata
├── vite.config.ts           # Relative base build paths with Tailwind v4
└── index.html               # Main HTML entry with Outfit and JetBrains Google Fonts
```

---

## 🚀 How to Run the Application

Follow these quick commands in your workspace:

### 1. Install Python Dependencies
Open your command terminal and make sure the required Python OCR packages are installed:
```powershell
pip install opencv-python easyocr
```

### 2. Launch Development Mode
Launch the unified Vite dev server and the Electron application concurrently:
```powershell
npm run electron:dev
```
*The app will start the Vite dev server, wait for port 5173 to be online, and then boot the Electron window automatically!*

### 3. Running in Hybrid Web Mode (Web Browser)
If you prefer running Vibe Studio in standard web browsers (Chrome, Brave, Edge, etc.) instead of the desktop Electron window:
```powershell
cmd /c "npm run server:dev"
```
*This concurrently boots the Vite React application on port `5173` and the local Node.js Express server on port `5000`. You can open `http://localhost:5173` in any browser!*

### 4. Custom Visual File Browser
- In **Desktop Electron Mode**, clicking "Import Video" launches the native OS file selection window.
- In **Hybrid Web Mode**, clicking "Import Video" automatically pops up our custom visual **File Browser Modal** overlay, allowing you to browse computer drives (`C:\`, `D:\`, etc.) and directories directly inside the webpage.

### 5. Packaging/Building the App
To compile both the React frontend and the Electron scripts for release:
```powershell
# Compiles React assets & Electron typescript files
npm run build
npm run build-electron
```
