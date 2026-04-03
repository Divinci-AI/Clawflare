#!/bin/bash
AGENT="main"
URL="https://docs.openclaw.ai/tools/browser"
echo "Testing browser tool with AGENT: $AGENT"
echo "Target URL: $URL"

# Capture JSON and filter out bedrock-discovery noise
RESULT=$(openclaw agent --agent "$AGENT" --message "Use your browser tool to navigate to $URL and tell me the page title." --json 2>/dev/null | grep -v "^\[")

if echo "$RESULT" | grep -q "\"status\":\"ok\""; then
    echo "✅ SUCCESS: Agent completed run."
    # Extract the response text
    echo "Agent Response:"
    echo "$RESULT" | grep -o "\"text\":\"[^\"]*\"" | head -n 1 | cut -d'"' -f4
else
    echo "❌ FAILED"
    echo "$RESULT" | head -n 20
fi
