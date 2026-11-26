#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: start.sh [-v|--verbose] CAPTURE [ARGS...] or start.sh [-v|--verbose] [--shared-adapter [--router-keepalive MINUTES]] {--forward WRITER [ARGS...] | --router EMBER_ROUTER [ARGS...]} -- CAPTURE [ARGS...]'
}

die() {
  echo "Error: $*" >&2
  exit 1
}

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
  usage
  exit
fi

VERBOSE=false
SHARED=false
KEEPALIVE_MINUTES=0
while true; do
  case "${1:-}" in
    -v|--verbose) VERBOSE=true ;;
    --shared-adapter) SHARED=true ;;
    --router-keepalive)
      [[ "${2:-}" =~ ^[1-9][0-9]{0,8}$ ]] || die '--router-keepalive requires a positive whole number of minutes.'
      KEEPALIVE_MINUTES=$2
      shift
      ;;
    *) break ;;
  esac
  shift
done

verbose() {
  if $VERBOSE; then
    printf 'Verbose [start.sh %(%T)T] %s\n' -1 "$*" >&2
  fi
}

FORWARD_CMD=()
ROUTER_CMD=()
if [[ "${1:-}" == --forward || "${1:-}" == --router ]]; then
  mode="$1"
  command_args=()
  shift
  while [[ $# -gt 0 && "$1" != -- ]]; do
    command_args+=("$1")
    shift
  done
  [[ ${#command_args[@]} -gt 0 && $# -gt 0 ]] || die "$(usage)"
  if [[ "$mode" == --router ]]; then
    ROUTER_CMD=("${command_args[@]}")
  else
    FORWARD_CMD=("${command_args[@]}")
  fi
  shift
elif $SHARED; then
  die '--shared-adapter requires --forward or --router.'
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
PASS_THROUGH_FORMAT="$(quoted_path "$(config_value pass_through_format)")" || PASS_THROUGH_FORMAT=json
PASS_THROUGH="$(config_value pass_through_commands)"
if ((${#ROUTER_CMD[@]})); then
  REDIRECT_STDOUT=false
elif [[ -z "$PASS_THROUGH" || "$PASS_THROUGH" =~ ^true[[:space:]]*(#.*)?$ ]]; then
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

if ((KEEPALIVE_MINUTES > 0)) && ! $SHARED; then
  die '--router-keepalive requires --shared-adapter with --forward or --router.'
fi

if $SHARED && [[ ! "$(config_value optimistic_climate_control)" =~ ^true[[:space:]]*(#.*)?$ ]]; then
  echo "Warning: Shared-adapter mode pauses capture during writes. It is recommended to set optimistic_climate_control = true in $CONFIG_FILE to show requested setpoints immediately in Home Assistant." >&2
fi

PIDS=()
OWNED_FIFOS=()
TEMP_DIR=''
ROUTER_SOCKET=''

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
  if [[ -n "$ROUTER_SOCKET" ]]; then
    rm -f -- "$ROUTER_SOCKET"
  fi
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

# Derive the outer deadlines from Ember Router's millisecond timeouts.
set_router_timeouts() {
  local arg option value
  local -A timeouts=([--timeout]=45000 [--write-timeout]=15000 [--read-timeout]=5000 [--settle-delay]=0)
  while (($#)); do
    arg=$1
    shift
    option=${arg%%=*}
    case "$option" in
      --timeout|--write-timeout|--read-timeout|--settle-delay)
        if [[ "$arg" == *=* ]]; then
          value=${arg#*=}
        elif (($#)); then
          value=$1
          shift
        else
          continue
        fi

        if [[ "$value" =~ ^0*([0-9]{1,6})$ ]]; then
          value=$((10#${BASH_REMATCH[1]}))
        elif [[ "$value" =~ ^0[xX]0*([[:xdigit:]]{1,5})$ ]]; then
          value=$((16#${BASH_REMATCH[1]}))
        else
          continue
        fi
        if ((value <= 300000)) && [[ $option == --settle-delay || $value -ge 100 ]]; then
          timeouts[$option]=$value
        fi
        ;;
    esac
  done

  # The APS delivery and ZCL reply timers run in parallel.
  local read_ms=${timeouts[--read-timeout]} write_ms=${timeouts[--write-timeout]}
  local reply_ms=$((read_ms > write_ms ? read_ms : write_ms))
  local reply_seconds=$(( (reply_ms + 999) / 1000 ))
  local client_seconds=$((reply_seconds + 10))
  if $SHARED; then
    # Allow time to open and close the adapter around the network transition.
    local startup_seconds=$(( (timeouts[--timeout] + 999) / 1000 + 15 ))
    local request_seconds=$((startup_seconds + reply_seconds))
    export ROUTER_REQUEST_TIMEOUT="${request_seconds}s"
    client_seconds=$((client_seconds + startup_seconds))
    if ((KEEPALIVE_MINUTES > 0)); then
      client_seconds=$((client_seconds + request_seconds + 10))
    fi
    if ((${#ROUTER_CMD[@]})); then
      local settle_seconds=$(( (timeouts[--settle-delay] + 999) / 1000 ))
      export SHARED_ROUTER_REQUEST_TIMEOUT="$((request_seconds + settle_seconds))s"
      client_seconds=$((client_seconds + settle_seconds))
    fi
  fi
  export VILOCAL_ROUTER_CLIENT_TIMEOUT_MS=$((1000 * (client_seconds > 40 ? client_seconds : 40)))
}

ensure_fifo "$FIFO"
if ((${#ROUTER_CMD[@]})); then
  TEMP_DIR="$(mktemp -d)"
  ROUTER_SOCKET="$TEMP_DIR/router.sock"
  export VILOCAL_ROUTER_SOCKET="$ROUTER_SOCKET"
  has_read_timeout=false
  has_settle_delay=false
  for arg in "${ROUTER_CMD[@]:1}"; do
    case "${arg%%=*}" in
      --read-timeout) has_read_timeout=true ;;
      --settle-delay) has_settle_delay=true ;;
    esac
  done
  if ! $has_read_timeout; then
    ROUTER_CMD+=(--read-timeout 15000)
  fi
  if $SHARED && ! $has_settle_delay; then
    ROUTER_CMD+=(--settle-delay 5000)
  fi
  set_router_timeouts "${ROUTER_CMD[@]:1}"
elif [[ ${#FORWARD_CMD[@]} -gt 0 ]] && $REDIRECT_STDOUT; then
  TEMP_DIR="$(mktemp -d)"
  COMMAND_FIFO="$TEMP_DIR/commands"
fi

if ((KEEPALIVE_MINUTES > 0 && ${#FORWARD_CMD[@]} > 0)) && [[ "$PASS_THROUGH_FORMAT" == ember-router ]]; then
  set_router_timeouts "${FORWARD_CMD[@]:1}"
fi

if [[ -n "$COMMAND_FIFO" ]]; then
  ensure_fifo "$COMMAND_FIFO"
  [[ ! "$FIFO" -ef "$COMMAND_FIFO" ]] || die 'capture and command FIFOs must be different'
fi

start_vilocal() {
  # Start Node directly so the launcher can signal it by PID.
  local -a command=(node --require ./.pnp.cjs --loader ./.pnp.loader.mjs --disable-warning=ExperimentalWarning ./index.js)
  if [[ ${#FORWARD_CMD[@]} -gt 0 ]] && $REDIRECT_STDOUT; then
    setsid "${command[@]}" > "$COMMAND_FIFO" &
  else
    setsid "${command[@]}" &
  fi
  VILOCAL_PID=$!
  PIDS+=("$VILOCAL_PID")
}

verbose "Config: $CONFIG_FILE; shared adapter: $SHARED"
if $SHARED; then
  start_vilocal
  SHARED_ARGS=()
  if $VERBOSE; then
    SHARED_ARGS+=(--verbose)
  fi
  SHARED_INPUT="$COMMAND_FIFO"
  SHARED_WRITER=("${FORWARD_CMD[@]}")
  if [[ -n "$ROUTER_SOCKET" ]]; then
    SHARED_ARGS+=(--socket "$ROUTER_SOCKET")
    SHARED_WRITER=("${ROUTER_CMD[@]}")
    SHARED_INPUT=/dev/null
  elif [[ "$PASS_THROUGH_FORMAT" == ember-router ]]; then
    SHARED_ARGS+=(--binary)
  fi
  VILOCAL_PID="$VILOCAL_PID" ROUTER_KEEPALIVE_SECONDS="$((KEEPALIVE_MINUTES * 60))" \
    setsid bash "$(dirname "$0")/start-shared.sh" "${SHARED_ARGS[@]}" "${SHARED_WRITER[@]}" -- "${PIPE_CMD[@]}" < "$SHARED_INPUT" > "$FIFO" &
  verbose "Shared-adapter helper started (PID $!)"
  PIDS+=("$!")
else
  setsid "${PIPE_CMD[@]}" > "$FIFO" &
  PIDS+=("$!")
  verbose "Capture process started (PID $!)"

  if [[ -n "$ROUTER_SOCKET" ]]; then
    setsid "${ROUTER_CMD[0]}" run --socket "$ROUTER_SOCKET" "${ROUTER_CMD[@]:1}" < /dev/null > /dev/null &
    PIDS+=("$!")
    verbose "Router process started (PID $!)"
  elif [[ ${#FORWARD_CMD[@]} -gt 0 ]]; then
    if $VERBOSE && [[ "$PASS_THROUGH_FORMAT" == ember-router ]]; then
      setsid "${FORWARD_CMD[@]}" < "$COMMAND_FIFO" > >(od -An -v -tx1 >&2) &
    elif $VERBOSE; then
      setsid "${FORWARD_CMD[@]}" < "$COMMAND_FIFO" >&2 &
    else
      setsid "${FORWARD_CMD[@]}" < "$COMMAND_FIFO" >/dev/null &
    fi
    PIDS+=("$!")
  elif [[ -n "$COMMAND_FIFO" ]]; then
    setsid cat -- "$COMMAND_FIFO" &
    PIDS+=("$!")
  fi

  start_vilocal
fi

STATUS=0
wait -n "${PIDS[@]}" || STATUS=$?
verbose "A launcher process exited with status $STATUS; cleaning up"
if [[ "$STATUS" -eq 0 ]]; then
  STATUS=1
fi
exit "$STATUS"
