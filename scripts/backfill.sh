#!/bin/bash
# Runs a backfill function in a loop until it reports remaining = 0.
#
# Usage:  bash scripts/backfill.sh backfill-embeddings 5
#         bash scripts/backfill.sh backfill-links 3
#
# It asks for your service role key when it starts. The key is typed hidden,
# kept only in memory for this run, and never written to any file or to your
# shell history.

FUNC="${1:?Give the function name, e.g. backfill-embeddings}"
BATCH="${2:-5}"
PROJECT_REF="nlemloarnxuamapltqej"
URL="https://${PROJECT_REF}.supabase.co/functions/v1/${FUNC}"

read -rsp "Paste your service role key and press Return (it stays hidden): " KEY
echo
if [ -z "$KEY" ]; then echo "No key entered. Stopping."; exit 1; fi
echo "Got a key starting with ${KEY:0:3}... (${#KEY} characters). (Either your sb_secret_ key or your legacy service_role key works.)"

OFFSET=0
while true; do
  RESULT=$(curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $KEY" \
    -d "{\"batch_size\": $BATCH, \"offset\": $OFFSET}")
  echo "$RESULT"

  if echo "$RESULT" | grep -q '"error"'; then
    echo "Stopped: the function returned an error (shown above)."
    exit 1
  fi

  REMAINING=$(echo "$RESULT" | sed -n 's/.*"remaining":\([0-9]*\).*/\1/p')
  OFFSET=$(echo "$RESULT" | sed -n 's/.*"offset_next":\([0-9]*\).*/\1/p')
  if [ -z "$REMAINING" ] || [ -z "$OFFSET" ]; then
    echo "Stopped: unexpected reply (shown above)."
    exit 1
  fi
  if [ "$REMAINING" = "0" ]; then
    echo "Done. Nothing left to backfill."
    break
  fi
  sleep 3
done
