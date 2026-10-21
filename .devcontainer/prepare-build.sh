#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DEST="${SCRIPT_DIR}/host-ca-certificates.crt"
CERT_TEMP="$(mktemp "${CERT_DEST}.XXXXXX")"
trap 'rm -f "$CERT_TEMP"' EXIT

has_certificate() {
    [[ -s "$1" ]] && grep -q -- '-----BEGIN CERTIFICATE-----' "$1"
}

export_macos() {
    local keychain
    while IFS= read -r keychain; do
        keychain="${keychain#*\"}"
        keychain="${keychain%\"*}"
        if [[ -r "$keychain" ]]; then
            security find-certificate -a -p "$keychain" >> "$CERT_TEMP" || return 1
        fi
    done < <(security list-keychains -d user; security list-keychains -d system)
}

export_windows() {
    local destination
    if grep -qi microsoft /proc/version 2>/dev/null; then
        destination="$(wslpath -w "$CERT_TEMP")" || return 1
    else
        destination="$(cygpath -w "$CERT_TEMP")" || return 1
    fi
    printf '%s\n' "$destination" | \
        powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
            $ErrorActionPreference = "Stop"
            $destination = [Console]::In.ReadLine()
            $certificates = Get-ChildItem Cert:\CurrentUser\Root, Cert:\LocalMachine\Root
            $pem = foreach ($certificate in $certificates) {
                $base64 = [Convert]::ToBase64String(
                    $certificate.RawData,
                    [Base64FormattingOptions]::InsertLineBreaks
                )
                "-----BEGIN CERTIFICATE-----`n$base64`n-----END CERTIFICATE-----`n"
            }
            [IO.File]::WriteAllText(
                $destination,
                ($pem -join ""),
                [Text.Encoding]::ASCII
            )
        '
}

export_host_bundle() {
    local bundle
    for bundle in \
        /etc/ssl/certs/ca-certificates.crt \
        /etc/ssl/certs/ca-bundle.crt \
        /etc/pki/tls/certs/ca-bundle.crt \
        /mingw64/etc/ssl/certs/ca-bundle.crt; do
        if [[ -r "$bundle" ]]; then
            echo "Copying certificates from $bundle..."
            cp "$bundle" "$CERT_TEMP"
            return 0
        fi
    done
    return 1
}

if command -v security >/dev/null 2>&1; then
    echo "Exporting certificates from macOS keychains..."
    export_macos || echo "Warning: macOS keychain export failed" >&2
elif command -v powershell.exe >/dev/null 2>&1; then
    echo "Exporting certificates from Windows root stores..."
    export_windows || echo "Warning: Windows certificate export failed" >&2
fi

if ! has_certificate "$CERT_TEMP"; then
    : > "$CERT_TEMP"
    export_host_bundle || true
fi

if ! has_certificate "$CERT_TEMP"; then
    echo "Warning: no host certificates found; the image keeps its default trust store" >&2
    : > "$CERT_TEMP"
fi

mv "$CERT_TEMP" "$CERT_DEST"
count="$(grep -c -- '-----BEGIN CERTIFICATE-----' "$CERT_DEST" || true)"
echo "Wrote $count host certificates to $CERT_DEST"