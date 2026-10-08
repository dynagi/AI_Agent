#!/bin/sh
# Starts AURA's two server processes in one container (see Dockerfile.render) and keeps them together:
# if either stops, the container exits so the host restarts both.

# 1. bring back the learned models saved in Supabase (no permanent disk on Render's free plan)
cd /app/ai-service
python -m app.services.data_sync restore

# 2. the AI service, private to this container
uvicorn app.main:app --host 127.0.0.1 --port 8001 --workers 1 &
AI=$!

# 3. the public API (Render sets $PORT)
cd /app/backend
node dist/index.js &
API=$!

# on shutdown (a deploy or restart), stop both politely so the AI service saves its learned files first
trap 'kill -TERM $API $AI 2>/dev/null; wait $AI; exit 0' TERM INT

while kill -0 $AI 2>/dev/null && kill -0 $API 2>/dev/null; do
  sleep 5
done
echo "a server process stopped; exiting so the container restarts"
kill -TERM $API $AI 2>/dev/null
wait
exit 1
