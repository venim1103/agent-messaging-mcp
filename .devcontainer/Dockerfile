FROM docker.io/library/node:24-bookworm

COPY host-ca-certificates.crt /tmp/host-ca-certificates.crt
RUN set -eu; \
    if grep -q -- '-----BEGIN CERTIFICATE-----' /tmp/host-ca-certificates.crt; then \
        dir=/usr/local/share/ca-certificates/host; \
        install -d "$dir"; \
        awk -v dir="$dir" '{ sub(/\r$/, "") } /-----BEGIN CERTIFICATE-----/ { n++; file = sprintf("%s/host-%04d.crt", dir, n) } file { print > file } /-----END CERTIFICATE-----/ { close(file); file = "" }' /tmp/host-ca-certificates.crt; \
        for cert in "$dir"/*.crt; do \
            openssl x509 -noout -in "$cert" 2>/dev/null || rm -f "$cert"; \
        done; \
        update-ca-certificates; \
    fi; \
    rm -f /tmp/host-ca-certificates.crt

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global npm@12.1.0