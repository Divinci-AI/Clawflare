#!/bin/bash
# Multi-turn bridge integration test — regression test for the reasoning-model stall fix.
#
# Tests the bridge directly (no OpenClaw agent overhead) with a synthetic conversation
# that includes a tool call + tool output in history, then a follow-up user message.
# This is the exact pattern that caused kimi-k2.5 to go silent before the fix.
#
# Tests:
#   1. Turn 1 / scout: plain message → verify text response
#   2. Turn 2 / scout: history with function_call + function_call_output + follow-up
#   3. Turn 2 / kimi:  same pattern — verifies min-max_tokens enforcement for reasoning models
#   4. Large tool output truncation — 20k char blob, verifies 12k truncation + response
set -euo pipefail

BRIDGE="http://127.0.0.1:18799"
SCOUT="@cf/meta/llama-4-scout-17b-16e-instruct"
KIMI="@cf/moonshotai/kimi-k2.5"

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "❌ CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set"
  exit 1
fi

# Ensure the bridge is running
if ! curl -sf "$BRIDGE" >/dev/null 2>&1; then
  echo "Starting Clawflare Bridge..."
  node "$(dirname "$0")/packages/cf-native/bridge.js" &
  BRIDGE_PID=$!
  sleep 2
  trap "kill $BRIDGE_PID 2>/dev/null" EXIT
fi

PASS=0
FAIL=0

parse_output() {
  # Accepts SSE stream or JSON on stdin, prints text content or [tool_call:name]
  python3 -c "
import sys, json
buf = sys.stdin.read()
lines = buf.splitlines()
is_sse = any(l.startswith('data:') for l in lines)
if is_sse:
    for line in lines:
        line = line.strip()
        if not line.startswith('data:'): continue
        raw = line[5:].strip()
        if raw == '[DONE]': break
        try:
            d = json.loads(raw)
            t = d.get('type','')
            if t == 'response.output_text.delta' and d.get('delta'):
                print(d['delta'], end='')
            elif t == 'response.output_item.added':
                item = d.get('item', {})
                if item.get('type') == 'function_call':
                    print('[tool_call:' + item.get('name','?') + ']', end='')
        except: pass
else:
    try:
        d = json.loads(buf)
        for item in d.get('output', []):
            if item.get('type') == 'function_call':
                print('[tool_call:' + item.get('name','?') + ']', end='')
            for c in item.get('content', []):
                if c.get('type') == 'output_text': print(c.get('text',''), end='')
    except: pass
" 2>/dev/null
}

run_test() {
  local name="$1"
  local payload="$2"
  local timeout="${3:-60}"

  echo -n "  $name... "
  local response
  response=$(curl -sf --max-time "$timeout" -X POST "$BRIDGE" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null) || {
    echo "❌ FAIL (curl error or timeout after ${timeout}s)"
    FAIL=$((FAIL + 1)); return
  }

  if [[ -z "$response" ]]; then
    echo "❌ FAIL (empty response from bridge)"
    FAIL=$((FAIL + 1)); return
  fi

  local output
  output=$(echo "$response" | parse_output)

  if [[ -n "$output" ]]; then
    echo "✅ PASS"
    echo "     → ${output:0:120}"
    PASS=$((PASS + 1))
  else
    echo "❌ FAIL (empty output — likely finish_reason=length or bridge error)"
    echo "     Raw: ${response:0:300}"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Multi-turn Bridge Integration Tests ==="
echo "Bridge: $BRIDGE"
echo ""

# ── Test 1: Single turn ───────────────────────────────────────────────────────
T1=$(cat <<EOF
{
  "model": "$SCOUT",
  "stream": true,
  "max_output_tokens": 256,
  "input": [
    {"type": "message", "role": "user", "content": "Reply with exactly: HELLO_WORLD"}
  ]
}
EOF
)
run_test "Turn 1 / scout: plain message" "$T1" 60

# ── Test 2: Multi-turn with tool history, llama-4-scout ──────────────────────
T2=$(cat <<EOF
{
  "model": "$SCOUT",
  "stream": true,
  "max_output_tokens": 256,
  "input": [
    {"type": "message", "role": "user", "content": "Search for the weather in Tokyo"},
    {"type": "function_call", "call_id": "call_abc123", "name": "search_web", "arguments": "{\"query\":\"Tokyo weather\"}"},
    {"type": "function_call_output", "call_id": "call_abc123", "output": "Tokyo: Partly cloudy, 18 degrees C"},
    {"type": "message", "role": "user", "content": "Should I bring an umbrella? Answer in one sentence."}
  ],
  "tools": [
    {"type": "function", "name": "search_web", "description": "Search the web",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ]
}
EOF
)
run_test "Turn 2 / scout: multi-turn with tool history" "$T2" 60

# ── Test 3: Multi-turn with tool history, kimi-k2.5 (reasoning model) ────────
# Sends max_output_tokens=512 which is below the 4096 minimum the bridge now enforces.
# Before the fix this caused a silent empty response (finish_reason=length).
T3=$(cat <<EOF
{
  "model": "$KIMI",
  "stream": true,
  "max_output_tokens": 512,
  "input": [
    {"type": "message", "role": "user", "content": "Search for the weather in Tokyo"},
    {"type": "function_call", "call_id": "call_xyz789", "name": "search_web", "arguments": "{\"query\":\"Tokyo weather\"}"},
    {"type": "function_call_output", "call_id": "call_xyz789", "output": "Tokyo: Partly cloudy, 18 degrees C"},
    {"type": "message", "role": "user", "content": "Should I bring an umbrella? Reply in one sentence."}
  ],
  "tools": [
    {"type": "function", "name": "search_web", "description": "Search the web",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ]
}
EOF
)
run_test "Turn 2 / kimi: multi-turn (low max_tokens → bridge bumps to 4096)" "$T3" 180

# ── Test 4: Large tool output truncation ─────────────────────────────────────
LARGE=$(python3 -c "import json; print(json.dumps('REPEATED_CONTENT ' * 1200))")
T4=$(cat <<EOF
{
  "model": "$SCOUT",
  "stream": true,
  "max_output_tokens": 128,
  "input": [
    {"type": "message", "role": "user", "content": "Summarize the result"},
    {"type": "function_call", "call_id": "call_big1", "name": "search_web", "arguments": "{\"query\":\"test\"}"},
    {"type": "function_call_output", "call_id": "call_big1", "output": $LARGE},
    {"type": "message", "role": "user", "content": "Just say OK."}
  ],
  "tools": [
    {"type": "function", "name": "search_web", "description": "Search the web",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ]
}
EOF
)
run_test "Large tool output: 20k chars → truncated to 12k" "$T4" 60

echo ""
echo "Results: $PASS passed, $FAIL failed out of $((PASS+FAIL))"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
