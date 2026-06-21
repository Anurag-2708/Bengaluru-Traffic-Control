#!/bin/bash
# GridAI - Start backend + frontend
# Usage: bash run.sh

# Always run from the project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "  GridAI Emergency Dispatch Control Room  "
echo "=========================================="

# ── Kill any previous instances ──────────────────────────────────────────────
echo ""
echo "[0/2] Cleaning up any existing processes on ports 8000 and 8501..."
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:8501 | xargs kill -9 2>/dev/null
sleep 1

# ── Start FastAPI backend ─────────────────────────────────────────────────────
echo ""
echo "[1/2] Starting FastAPI backend on http://localhost:8000 ..."
PYTHONPATH="$SCRIPT_DIR" "$SCRIPT_DIR/venv/bin/uvicorn" src.main:app \
    --host 0.0.0.0 --port 8000 --reload \
    --reload-dir "$SCRIPT_DIR/src" \
    --reload-dir "$SCRIPT_DIR/density_extracted" &
BACKEND_PID=$!
echo "      Backend PID: $BACKEND_PID"

# Wait until backend is healthy (poll /mappings up to 30s)
echo "      Waiting for backend to be ready..."
for i in $(seq 1 30); do
    if curl -sf --noproxy '*' http://localhost:8000/mappings > /dev/null 2>&1; then
        echo "      ✅ Backend ready! (${i}s)"
        break
    fi
    sleep 1
done

# ── Start React frontend ──────────────────────────────────────────────────────
echo ""
echo "[2/2] Starting React dashboard on http://localhost:8501 ..."
npm --prefix "$SCRIPT_DIR/frontend" run dev -- --port 8501 --host 0.0.0.0 &
FRONTEND_PID=$!
echo "      Frontend PID: $FRONTEND_PID"

echo ""
echo "=========================================="
echo "  App running:"
echo "    Backend  → http://localhost:8000"
echo "    Frontend → http://localhost:8501"
echo "  Press Ctrl+C to stop all services."
echo "=========================================="

# Trap Ctrl+C to kill both cleanly
trap '
    echo ""
    echo "Shutting down GridAI..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
    echo "Done."
    exit 0
' INT TERM

wait
