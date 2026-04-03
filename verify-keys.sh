#!/bin/bash
ACCOUNT_ID="14a6fa23390363382f378b5bd4a0f849"
KEYS=("tzg7Cb0un6dX7jSP91HKV-IQQ4l_5_u-YAiP1TNN" "_xMw3GYNi4Vg6ZllLOIFB5o8Lg_AtN-LqPqMuhA8")

for KEY in "${KEYS[@]}"; do
    echo "Testing key: ${KEY:0:4}...${KEY: -4}"
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/moonshotai/kimi-k2.5" \
         -H "Authorization: Bearer $KEY" \
         -H "Content-Type: application/json" \
         -d '{"messages":[{"role":"user","content":"ping"}]}')
    echo "Result: $RESPONSE"
done
