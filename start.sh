#!/usr/bin/env bash
set -euo pipefail

# read the name for the FIFO pipe from the configuration file
CONFIG_FILE=""

if [ -f "./local_config.toml" ]; then
  CONFIG_FILE="./local_config.toml"
elif [ -f "./config.toml" ]; then
  CONFIG_FILE="./config.toml"
else
  echo "Error: neither local_config.toml nor config.toml found" >&2
  exit 1
fi

FIFO="$(sed -nE '
  /^[[:space:]]*#/d; # drop commented lines
  /^[[:space:]]*named_pipe[[:space:]]*=/{
    s/.*=[[:space:]]*"([^"]*)".*/\1/p
  }
' "$CONFIG_FILE")"
if [ -z "$FIFO" ]; then
  echo "Error: named_pipe not set in $CONFIG_FILE" >&2
  exit 1
fi

# cleanup the fifo (on exit)
cleanup() {
  rm -f "$FIFO"
}
trap cleanup EXIT

rm -f "$FIFO"
mkfifo -m 600 "$FIFO"

# the input is passed as an argument to the script
if [ "$#" -eq 0 ]; then
  echo "Error: specify the command generating the (P)CAP input as argument to this script" >&2
  exit 1
fi

PIPE_CMD=("$@")

# start the producer
"${PIPE_CMD[@]}" > "$FIFO" &
INPUT_PID=$!

# start ViLocal (consumer)
yarn run start &
YARN_PID=$!

# Wait until *one* of them exits
wait -n "$INPUT_PID" "$YARN_PID"
STATUS=$?

# Kill the other one
kill "$INPUT_PID" "$YARN_PID" 2>/dev/null || true
wait "$INPUT_PID" "$YARN_PID" 2>/dev/null || true

# Treat *any* exit as failure so systemd restarts it
if [ "$STATUS" -eq 0 ]; then
  STATUS=1
fi

exit "$STATUS"
