#!/bin/bash
# Usage: CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> ./verify-keys.sh
# Or set the env vars in your shell before running.

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

# Space-separated list of tokens to test; defaults to CLOUDFLARE_API_TOKEN
KEYS=("${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}")

for KEY in "${KEYS[@]}"; do
    echo "Testing key: ${KEY:0:4}...${KEY: -4}"
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/moonshotai/kimi-k2.5" \
        -H "Authorization: Bearer $KEY" \
        -H "Content-Type: application/json" \
        -d '{"messages":[{"role":"user","content":"ping"}]}')
    echo "Result: $RESPONSE"
done
