#!/bin/bash
set -e

BODY=$(cat test-payload.json)
SECRET=$(grep TALLY_SIGNING_SECRET .dev.vars | cut -d '=' -f2)
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -i -X POST http://localhost:8787/hooks/tally \
  -H "Tally-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
