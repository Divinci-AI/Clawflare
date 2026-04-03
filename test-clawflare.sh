#!/bin/bash
MODEL="cf-native/@cf/moonshotai/kimi-k2.5"
echo "Testing model: $MODEL via Production Bridge"
# Capture JSON only by stripping non-JSON lines
RESULT=$(openclaw agent --agent main --message "Say hello" --json 2>/dev/null | grep -v "^\[")

if [[ $RESULT == *"\"status\":\"ok\""* ]]; then
    echo "✅ SUCCESS: Agent responded!"
    # Use simple grep to extract text content
    TEXT=$(echo "$RESULT" | grep -o "\"text\":\"[^\"]*\"" | head -n 1 | cut -d'"' -f4)
    echo "Agent says: $TEXT"
else
    echo "❌ FAILED"
    echo "$RESULT"
fi
