#!/bin/bash
BASE="https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main"
V1=(overview initialization session-setup prompt-turn content tool-calls file-system terminals agent-plan session-modes slash-commands extensibility schema authentication error elicitation cancellation session-config-options session-delete session-list transports)
V2=(overview migration initialization session-setup prompt-lifecycle content tool-calls extensibility schema authentication error elicitation cancellation session-config-options session-delete session-list slash-commands transports)
fail=0
for f in "${V1[@]}"; do
  curl -sfL --max-time 25 "$BASE/docs/protocol/v1/$f.mdx" -o "v1docs/$f.mdx" || { echo "FAIL v1 $f"; fail=1; }
done
for f in "${V2[@]}"; do
  curl -sfL --max-time 25 "$BASE/docs/protocol/v2/$f.mdx" -o "v2docs/$f.mdx" || { echo "FAIL v2 $f"; fail=1; }
done
echo "done fail=$fail"
