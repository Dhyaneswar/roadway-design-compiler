@echo off
cd /d "%~dp0"
echo Starting Roadway Design Compiler studio...
echo Opens at http://localhost:5173  (keep this window open; close it to stop)
npx vite studio --port 5173 --open
