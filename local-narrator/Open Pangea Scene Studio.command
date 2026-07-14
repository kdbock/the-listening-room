#!/bin/zsh
cd "/Users/kristykelly/Documents/Pangea/Scene Studio/local-narrator/scene-studio" || exit 1
PYTHON="/Users/kristykelly/.local/share/local-narration-studio/venv/bin/python"
if curl -sf "http://127.0.0.1:8765/api/workspace" >/dev/null 2>&1; then
  open "http://127.0.0.1:8765"
  exit 0
fi
"$PYTHON" server.py --port 8765 &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:8765"
wait $SERVER_PID
