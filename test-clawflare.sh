#!/bin/bash
MODEL="cf-native/@cf/moonshotai/kimi-k2.5"
echo "Testing model: $MODEL via Production Bridge"
RESULT=$(openclaw agent --agent main --message "Say hello" --json 2>&1)
if echo "$RESULT" | grep -q "\"reply\":"; then 
    echo "✅ SUCCESS: Agent responded!"
    echo "$RESULT" | grep -o "\"reply\":\".*\"" | head -n 1
else 
    echo "❌ FAILED"
    echo "$RESULT" | head -n 10
fi
