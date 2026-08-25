#!/usr/bin/env bash
# aidlc-dashboard launcher — macOS / Linux. Run it from a terminal.
#
# WHY THIS EXISTS RATHER THAN JUST `bun run src/server.ts`:
#   1. bun installs to ~/.bun/bin, which is on PATH only for shells that read
#      the user profile. A non-interactive or freshly-installed shell would hit
#      "command not found", so we probe the known install locations too.
#   2. First run needs `bun install`; forgetting it produces a confusing error.
#   3. The browser should open by itself, and only once the port answers.
#
# usage:
#   ./start.sh                      폴더 선택 화면으로 시작
#   ./start.sh ~/path/to/workspace  그 워크스페이스로 바로 시작
#   ./start.sh --port 5000 --poll 0 서버 플래그는 그대로 전달된다

set -euo pipefail

# Run from the script's own directory so relative paths hold no matter where the
# script was invoked from (e.g. `~/tools/aidlc-dashboard/start.sh` from $HOME).
cd "$(dirname "${BASH_SOURCE[0]}")"

# ---- locate bun -------------------------------------------------------------
# PATH first, then the documented install locations (a shell that has not read
# the user profile does not have ~/.bun/bin on PATH).
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  local candidate
  for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if ! BUN="$(find_bun)"; then
  cat >&2 <<'MSG'
✗ bun 을 찾지 못했다.

AI-DLC 는 bun 이 필수다. 설치:

    curl -fsSL https://bun.sh/install | bash

설치 후 터미널을 새로 열고 다시 실행한다.
MSG
  exit 1
fi

echo "▸ bun $("$BUN" --version) ($BUN)"

# ---- dependencies -----------------------------------------------------------
# Only 3 dev deps (types + tsc), so this is quick and idempotent.
if [ ! -d node_modules ]; then
  echo "▸ 의존성 설치 (최초 1회)..."
  "$BUN" install
fi

# ---- arguments --------------------------------------------------------------
# A bare first argument is taken as the workspace path, so
# `./start.sh ~/ws` works without remembering the --root flag.
ARGS=()
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
  ARGS+=(--root "$1")
  shift
fi
ARGS+=("$@")

# Read the port back out of the arguments so the browser opens the right URL.
PORT=4321
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [ "${ARGS[$i]}" = "--port" ] && [ $((i + 1)) -lt ${#ARGS[@]} ]; then
    PORT="${ARGS[$((i + 1))]}"
  fi
done
URL="http://localhost:${PORT}"

# ---- open the browser once the port answers ---------------------------------
# Backgrounded: the server has to start before there is anything to open. Polling
# beats a fixed sleep — a cold start is fast but a big audit log is not.
(
  for _ in $(seq 1 40); do   # ~10s ceiling
    if curl -s -o /dev/null --max-time 1 "$URL/healthz" 2>/dev/null; then
      if command -v open >/dev/null 2>&1; then
        open "$URL"                    # macOS
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$URL" >/dev/null 2>&1  # Linux
      else
        echo "▸ 브라우저에서 열기: $URL"
      fi
      exit 0
    fi
    sleep 0.25
  done
  echo "▸ 서버 응답을 못 받았다 — 직접 열어본다: $URL" >&2
) &

echo "▸ $URL  (Ctrl+C 로 종료)"
echo

# exec so Ctrl+C reaches the server directly and the exit status is its own.
#
# ⚠️ macOS still ships bash 3.2 as /bin/bash, so `/usr/bin/env bash` resolves to
# 3.2 on any Mac without a newer bash on PATH. In 3.2, "${ARGS[@]}" on an EMPTY
# array trips `set -u` with "unbound variable" — i.e. the no-argument case, the
# most common way to launch this (verified: `bash -c 'set -u; A=(); echo
# "${A[@]}"'` dies on 3.2, passes on 5.x). The `${ARGS[@]+...}` guard expands to
# nothing when the array is empty and is correct in both.
# Do not "simplify" it back to "${ARGS[@]}".
exec "$BUN" run src/server.ts ${ARGS[@]+"${ARGS[@]}"}
