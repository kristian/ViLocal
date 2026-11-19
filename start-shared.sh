#!/usr/bin/env bash
set -euo pipefail

VERBOSE=false
if [[ "${1:-}" == --verbose || "${1:-}" == -v ]]; then
  VERBOSE=true
  shift
fi

verbose() {
  if $VERBOSE; then
    printf 'Verbose [start-shared.sh %(%T)T] %s\n' -1 "$*" >&2
  fi
}

writer=()
while (($#)) && [[ $1 != -- ]]; do
  writer+=("$1")
  shift
done
if ((${#writer[@]} == 0 || $# < 2)); then
  echo "Usage: start-shared.sh [-v|--verbose] WRITER [ARGS...] -- CAPTURE [ARGS...]" >&2
  exit 1
fi
shift
capture=("$@")

for utility in node setsid timeout; do
  if ! command -v "$utility" >/dev/null; then
    echo "Error: shared adapter mode requires $utility" >&2
    exit 1
  fi
done

work_dir=$(mktemp -d)
session_fifo="$work_dir/capture"
header_file="$work_dir/header"
ready_file="$work_dir/ready"
command_file="$work_dir/command"
capture_pid=
relay_pid=
writer_pid=
write_timeout=30s

# Stop the whole process group before giving the adapter to the next command.
stop_group() {
  local pid=$1 i
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < 20; i++)); do
    if ! kill -0 -- "-$pid" 2>/dev/null && ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  trap '' INT TERM
  if [[ -n $writer_pid ]]; then
    stop_group "$writer_pid"
  fi
  if [[ -n $capture_pid ]]; then
    stop_group "$capture_pid"
  fi
  if [[ -n $relay_pid ]]; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
  rm -f -- "$session_fifo" "$header_file" "$command_file" "$ready_file"
  rmdir -- "$work_dir"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkfifo -m 600 "$session_fifo"

script_dir=$(dirname -- "$0")

start_capture() {
  local i
  rm -f -- "$ready_file"
  node "$script_dir/pcap-relay.js" "$header_file" < "$session_fifo" &
  relay_pid=$!
  setsid -- bash -c '
    fifo=$1 ready=$2
    shift 2
    exec > "$fifo"
    : > "$ready"
    exec "$@"
  ' capture "$session_fifo" "$ready_file" "${capture[@]}" < /dev/null &
  capture_pid=$!

  # If writes queue up, do not stop a session before both FIFO ends open.
  for ((i = 0; i < 100; i++)); do
    if [[ -f $ready_file ]]; then
      verbose "Capture FIFO connected (capture PID $capture_pid, relay PID $relay_pid)"
      return 0
    fi
    check_capture
    sleep 0.02
  done
  echo "Error: capture session FIFO did not open" >&2
  exit 1
}

check_capture() {
  local pid status=0
  for pid in "$capture_pid" "$relay_pid"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || status=$?
      echo "Error: capture process or PCAP relay exited unexpectedly (status $status)" >&2
      exit "$((status == 0 ? 1 : status))"
    fi
  done
}

write_command() {
  local line=$1 newline=$2 status=0
  if [[ -z ${line//[[:space:]]/} ]]; then
    return 0
  fi

  check_capture
  verbose "Command received; stopping capture (PID $capture_pid)"
  stop_group "$capture_pid"
  verbose 'Capture stopped; waiting for its relay to drain'
  capture_pid=
  wait "$relay_pid"
  relay_pid=

  printf '%s%s' "$line" "$newline" > "$command_file"
  local -a write_cmd=(setsid -- timeout -k 5 "$write_timeout" "${writer[@]}")
  if $VERBOSE; then
    "${write_cmd[@]}" < "$command_file" >&2 &
  else
    "${write_cmd[@]}" < "$command_file" >/dev/null &
  fi
  writer_pid=$!
  verbose "Writer started (PID $writer_pid); waiting up to $write_timeout for it to exit"
  wait "$writer_pid" || status=$?
  writer_pid=
  verbose "Writer exited with status $status"
  if ((status != 0)); then
    echo "Warning: write command exited with status $status; restarting capture" >&2
  fi

  verbose 'Restarting capture'
  start_capture
}

start_capture
partial=
while true; do
  check_capture
  if IFS= read -r -t 0.2 chunk; then
    write_command "$partial$chunk" $'\n'
    partial=
  else
    status=$?
    partial+=$chunk
    if ((status <= 128)); then
      write_command "$partial" ''
      exit 0
    fi
  fi
done
