#!/bin/bash
# Imports the "JARVIS Desk Signing" certificate (JD-88) into a temp keychain for scripts/sign-mac.cjs.
# Reads MAC_SIGN_P12 (the .p12, base64) and MAC_SIGN_PASSWORD; writes JARVIS_SIGN_IDENTITY and
# JARVIS_SIGN_KEYCHAIN to $GITHUB_ENV. Used by release.yml (Matthew's certificate) and by CI's desk-mac
# job (a throwaway one, made by scripts/make-sign-cert.sh, to test the signing path).
set -euo pipefail
: "${MAC_SIGN_P12:?}" "${MAC_SIGN_PASSWORD:?}" "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}"
KC="$RUNNER_TEMP/jarvis-sign.keychain-db"
P12="$RUNNER_TEMP/jarvis-sign.p12"
printf '%s' "$MAC_SIGN_P12" | base64 --decode > "$P12"
security create-keychain -p "" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "" "$KC"
security import "$P12" -k "$KC" -P "$MAC_SIGN_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KC" > /dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
rm -f "$P12"
ID=$(security find-identity -p codesigning "$KC" | awk '/"JARVIS Desk Signing"/ { print $2; exit }')
if [ -z "$ID" ]; then
  echo "::error::No \"JARVIS Desk Signing\" identity in MAC_SIGN_P12"
  exit 1
fi
echo "Signing with JARVIS Desk Signing ($ID)"
echo "JARVIS_SIGN_IDENTITY=$ID" >> "$GITHUB_ENV"
echo "JARVIS_SIGN_KEYCHAIN=$KC" >> "$GITHUB_ENV"
