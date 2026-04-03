#!/bin/bash
# Basic connectivity test — runs a single agent turn against cf-native/@cf/moonshotai/kimi-k2.5
set -euo pipefail

AGENT="cf-test"
MODEL="cf-native/@cf/moonshotai/kimi-k2.5"

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_API_KEY:-}" ]]; then
  echo "❌ CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY must be set"
  exit 1
fi

# Ensure the bridge is running
if ! curl -sf http://127.0.0.1:18799 >/dev/null 2>&1; then
  echo "Starting Clawflare Bridge..."
  node "$(dirname "$0")/packages/cf-native/bridge.js" &
  BRIDGE_PID=$!
  sleep 2
  trap "kill $BRIDGE_PID 2>/dev/null" EXIT
fi

echo "Testing model: $MODEL via agent: $AGENT"

RESULT=$(openclaw agent --agent "$AGENT" --message "Say hello" --json 2>/dev/null | grep -v "^\[")

if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('status')=='ok' else 1)" 2>/dev/null; then
  echo "✅ SUCCESS: Agent responded!"
  echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Agent says:', d['result']['payloads'][0]['text'][:200])" 2>/dev/null || true
  # Verify the response actually came from cf-native
  PROVIDER=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('meta',{}).get('agentMeta',{}).get('provider','unknown'))" 2>/dev/null)
  echo "Provider used: $PROVIDER"
  if [[ "$PROVIDER" != "cf-native" ]]; then
    echo "⚠️  WARNING: Expected cf-native but got $PROVIDER — check openclaw.json and CLOUDFLARE env vars"
    exit 1
  fi
else
  echo "❌ FAILED"
  echo "$RESULT" | head -20
  exit 1
fi
