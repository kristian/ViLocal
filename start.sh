#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: start.sh CAPTURE [ARGS...] or start.sh [--shared-adapter] --forward WRITER [ARGS...] -- CAPTURE [ARGS...]'
}

die() {
  echo "Error: $*" >&2
  exit 1
}

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
  usage
  exit
fi

SHARED=false
if [[ "${1:-}" == --shared-adapter ]]; then
  SHARED=true
  shift
fi

FORWARD_CMD=()
if [[ "${1:-}" == --forward ]]; then
  shift
  while [[ $# -gt 0 && "$1" != -- ]]; do
    FORWARD_CMD+=("$1")
    shift
  done
  [[ ${#FORWARD_CMD[@]} -gt 0 && $# -gt 0 ]] || die "$(usage)"
  shift
elif $SHARED; then
  die '--shared-adapter requires --forward.'
elif [[ "${1:-}" == -- ]]; then
  shift
fi

[[ $# -gt 0 ]] || die "$(usage)"
PIPE_CMD=("$@")

if [[ -f ./local_config.toml ]]; then
  CONFIG_FILE=./local_config.toml
elif [[ -f ./config.toml ]]; then
  CONFIG_FILE=./config.toml
else
  die 'neither local_config.toml nor config.toml found'
fi

# Read scalar settings from the root of the TOML file.
config_value() {
  sed -nE "/^[[:space:]]*\[/q; s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)$/\1/p" "$CONFIG_FILE"
}

quoted_path() {
  local basic='^"([^"\\]*)"[[:space:]]*(#.*)?$'
  local literal="^'([^']*)'[[:space:]]*(#.*)?$"
  if [[ "$1" =~ $basic || "$1" =~ $literal ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

FIFO="$(quoted_path "$(config_value named_pipe)")" && [[ -n "$FIFO" ]] ||
  die "named_pipe must be a nonempty quoted path in $CONFIG_FILE"

COMMAND_FIFO=''
PASS_THROUGH="$(config_value pass_through_commands)"
if [[ -z "$PASS_THROUGH" || "$PASS_THROUGH" =~ ^true[[:space:]]*(#.*)?$ ]]; then
  REDIRECT_STDOUT=true
elif [[ "$PASS_THROUGH" =~ ^false[[:space:]]*(#.*)?$ ]]; then
  REDIRECT_STDOUT=false
  FORWARD_CMD=()
  SHARED=false
else
  REDIRECT_STDOUT=false
  COMMAND_FIFO="$(quoted_path "$PASS_THROUGH")" && [[ -n "$COMMAND_FIFO" ]] ||
    die "pass_through_commands must be true, false or a quoted FIFO path in $CONFIG_FILE"
fi

if $SHARED && [[ ! "$(config_value optimistic_climate_control)" =~ ^true[[:space:]]*(#.*)?$ ]]; then
  echo "Warning: Shared-adapter mode pauses capture during writes. It is recommended to set optimistic_climate_control = true in $CONFIG_FILE to show requested setpoints immediately in Home Assistant." >&2
fi

PIDS=()
OWNED_FIFOS=()
TEMP_DIR=''

cleanup() {
  local pid pipe
  for pid in "${PIDS[@]}"; do
    # A child blocked on a FIFO redirection might not have started setsid yet.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ ${#PIDS[@]} -gt 0 ]]; then
    wait "${PIDS[@]}" 2>/dev/null || true
  fi
  for pipe in "${OWNED_FIFOS[@]}"; do
    if [[ -p "$pipe" && ! -L "$pipe" ]]; then
      rm -f -- "$pipe"
    fi
  done
  if [[ -n "$TEMP_DIR" ]]; then
    rmdir -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_fifo() {
  if [[ -L "$1" ]] || [[ -e "$1" && ! -p "$1" ]]; then
    die "expected a FIFO at $1"
  fi
  if [[ ! -p "$1" ]]; then
    mkfifo -m 600 -- "$1"
    OWNED_FIFOS+=("$1")
  fi
}

ensure_fifo "$FIFO"
if [[ ${#FORWARD_CMD[@]} -gt 0 ]] && $REDIRECT_STDOUT; then
  TEMP_DIR="$(mktemp -d)"
  COMMAND_FIFO="$TEMP_DIR/commands"
fi

if [[ -n "$COMMAND_FIFO" ]]; then
  ensure_fifo "$COMMAND_FIFO"
  [[ ! "$FIFO" -ef "$COMMAND_FIFO" ]] || die 'capture and command FIFOs must be different'
fi

if $SHARED; then
  setsid bash "$(dirname "$0")/start-shared.sh" "${FORWARD_CMD[@]}" -- "${PIPE_CMD[@]}" < "$COMMAND_FIFO" > "$FIFO" &
  PIDS+=("$!")
else
  setsid "${PIPE_CMD[@]}" > "$FIFO" &
  PIDS+=("$!")

  if [[ ${#FORWARD_CMD[@]} -gt 0 ]]; then
    setsid "${FORWARD_CMD[@]}" < "$COMMAND_FIFO" >&2 &
    PIDS+=("$!")
  elif [[ -n "$COMMAND_FIFO" ]]; then
    setsid cat -- "$COMMAND_FIFO" &
    PIDS+=("$!")
  fi
fi

if [[ ${#FORWARD_CMD[@]} -gt 0 ]] && $REDIRECT_STDOUT; then
  setsid yarn run start > "$COMMAND_FIFO" &
else
  setsid yarn run start &
fi
PIDS+=("$!")

STATUS=0
wait -n "${PIDS[@]}" || STATUS=$?
if [[ "$STATUS" -eq 0 ]]; then
  STATUS=1
fi
exit "$STATUS"
