#!/bin/bash
# Makes the self-signed "JARVIS Desk Signing" code-signing certificate (JD-88) as a .p12 in the
# current folder, with macOS's own /usr/bin/openssl (LibreSSL: its .p12 imports with `security`).
# Matthew runs it once on his Mac (docs/desk-install.md → Signing); CI runs it for a throwaway one.
# Prints the .p12's password; keep it with the .p12 (a password manager), never in the repo.
set -euo pipefail
OPENSSL=/usr/bin/openssl
CNF=$(mktemp)
cat > "$CNF" <<'CONF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = JARVIS Desk Signing
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CONF
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$CNF" \
  -keyout jarvis-sign.key -out jarvis-sign.crt 2> /dev/null
PASS=$("$OPENSSL" rand -hex 16)
"$OPENSSL" pkcs12 -export -inkey jarvis-sign.key -in jarvis-sign.crt -name "JARVIS Desk Signing" \
  -out jarvis-sign.p12 -passout "pass:$PASS"
rm -f jarvis-sign.key "$CNF"
echo "$PASS"
