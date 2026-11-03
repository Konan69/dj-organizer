#!/usr/bin/env bash
# start / stop / restart without pkill pattern self-matching the calling shell
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8765}"
PIDF="data/server.pid"
LOG="data/server.log"
mkdir -p data

stop() {
  if [ -f "$PIDF" ]; then
    PID=$(cat "$PIDF")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null
      for _ in 1 2 3 4 5; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
      kill -9 "$PID" 2>/dev/null
    fi
    rm -f "$PIDF"
  fi
}

start() {
  # dj-sync Worker credentials for /api/ytm/pull
  [ -f data/sync.env ] && { set -a; . data/sync.env; set +a; }
  setsid bun api/src/index.ts "$PORT" >>"$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDF"
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "http://localhost:$PORT/api/state"; then
      echo "up   http://localhost:$PORT   (pid $(cat "$PIDF"))"
      return 0
    fi
    sleep 1
  done
  echo "FAILED to start — last log lines:"; tail -25 "$LOG"; return 1
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop; echo "stopped" ;;
  restart) stop; start ;;
  status)  curl -sf "http://localhost:$PORT/api/state" >/dev/null && echo "up on $PORT" || echo "down" ;;
  log)     tail -f "$LOG" ;;
  *) echo "usage: $0 {start|stop|restart|status|log}"; exit 2 ;;
esac
