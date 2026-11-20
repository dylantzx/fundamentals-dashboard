#!/bin/bash
# Double-click to start Steady. Close this window (or press Control-C) to stop it.
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4600}"
URL="http://localhost:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (version 20 or newer), then try again."
  read -r -p "Press Return to close."
  exit 1
fi

# Open the browser as soon as the app answers.
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$URL"; then open "$URL"; exit 0; fi
    sleep 0.5
  done
  echo "Steady did not start within 30 seconds. See the messages above."
) &

echo "Starting Steady at $URL"
echo "To stop Steady, close this window or press Control-C."
exec node server.js
