#!/usr/bin/env bash
# Portable form of the parent invocation used by this pilot.
# Usage: run-template.sh SNAPSHOT PROMPT OUTPUT_JSONL STDERR_LOG TOOLS
# Example TOOLS: read,grep,find,ls or read,grep,find,ls,pi_subagent
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 SNAPSHOT PROMPT OUTPUT_JSONL STDERR_LOG TOOLS" >&2
  exit 2
fi

snapshot=$(realpath "$1")
prompt=$(realpath "$2")
output=$(realpath -m "$3")
stderr_log=$(realpath -m "$4")
tools=$5
pilot_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$pilot_root" rev-parse --show-toplevel)
extension="$repo_root/live/extensions/pi-subagent/index.ts"

mkdir -p "$(dirname "$output")" "$(dirname "$stderr_log")"
cd "$snapshot"
timeout --signal=TERM --kill-after=10s 1200s \
  pi --mode json --print --no-session \
  --model openai-codex/gpt-5.6-sol --thinking high \
  --tools "$tools" \
  --no-extensions --extension "$extension" \
  --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve --offline \
  < "$prompt" > "$output" 2> "$stderr_log"
