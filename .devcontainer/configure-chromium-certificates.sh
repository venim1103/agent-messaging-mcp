#!/bin/bash
set -euo pipefail
umask 077

NSS_DIR="$HOME/.pki/nssdb"
mkdir -p "$NSS_DIR"
if [[ ! -f "$NSS_DIR/cert9.db" ]]; then
    certutil -N --empty-password -d "sql:$NSS_DIR"
fi

count=0
for certificate in /usr/local/share/ca-certificates/host/*.crt; do
    [[ -f "$certificate" ]] || continue
    fingerprint="$(openssl x509 -in "$certificate" -noout -fingerprint -sha256)"
    fingerprint="${fingerprint#*=}"
    fingerprint="${fingerprint//:/}"
    certutil -A -d "sql:$NSS_DIR" -n "devcontainer-host-$fingerprint" \
        -t 'C,,' -i "$certificate"
    count=$((count + 1))
done

echo "Configured Chromium NSS trust with $count host certificates."