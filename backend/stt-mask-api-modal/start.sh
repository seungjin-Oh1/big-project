#!/usr/bin/env bash
# Launches main.py (qwen3-asr conda env, port 9000). Privacy filtering now
# runs in-process inside main.py, so there's no separate service to start.
set -euo pipefail

SESSION="clawops"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONDA_SH="$(conda info --base)/etc/profile.d/conda.sh"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "tmux session '$SESSION' already exists, attaching..."
    exec tmux attach -t "$SESSION"
fi

if [ -z "${MODAL_ASR_WS_URL:-}" ]; then
    read -rp "Modal ASR websocket URL (leave blank to use main.py's default): " MODAL_ASR_WS_URL
fi

tmux new-session -d -s "$SESSION" -n app -c "$PROJECT_DIR"
tmux set-window-option -t "$SESSION:app" pane-border-status top
tmux select-pane -t "$SESSION:app.0" -T "main (9000)"

MAIN_CMD="source '$CONDA_SH' && conda activate qwen3-asr"
if [ -n "$MODAL_ASR_WS_URL" ]; then
    MAIN_CMD+=" && export MODAL_ASR_WS_URL='$MODAL_ASR_WS_URL'"
fi
MAIN_CMD+=" && uvicorn main:app --host 0.0.0.0 --port 9000"

tmux send-keys -t "$SESSION:app.0" "$MAIN_CMD" C-m

exec tmux attach -t "$SESSION"
