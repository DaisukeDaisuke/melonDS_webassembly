#!/usr/bin/env bash
# Match dummy-certs-linux in dq9_micro_dwc_server_emulator.cpp's workflow.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${1:-$root/certs}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
prefix="${OPENSSL_PREFIX:-$root/../../webassembly/tools/openssl-1.1.1w}"
mkdir -p "$prefix"
prefix="$(cd "$prefix" && pwd)"
ssl="$prefix/bin/openssl"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
if [[ ! -x "$ssl" ]]; then
  curl --fail --location --silent --show-error \
    'https://github.com/openssl/openssl/archive/refs/tags/OpenSSL_1_1_1w.tar.gz' --output "$temporary/openssl.tar.gz"
  tar -xf "$temporary/openssl.tar.gz" -C "$temporary"
  (
    cd "$temporary/openssl-OpenSSL_1_1_1w"
    ./config --prefix="$prefix" no-shared no-tests enable-ssl3 enable-ssl3-method enable-weak-ssl-ciphers
    make -j2
    make install_sw
    make install_ssldirs
  )
fi
[[ "$($ssl version)" == 'OpenSSL 1.1.1w '* ]] || { echo 'Certificate generation requires OpenSSL 1.1.1w' >&2; exit 1; }
cd "$temporary"
curl --fail --location --silent --show-error \
  'https://larsenv.github.io/NintendoCerts/WII_NWC_1_CERT.p12' --output WII_NWC_1_CERT.p12
"$ssl" pkcs12 -in WII_NWC_1_CERT.p12 -passin pass:alpine -passout pass:alpine -out keys.txt
sed -n '7,29p' keys.txt > nwc.crt
sed -n '33,50p' keys.txt > nwc.key
"$ssl" genrsa -out server.key 1024
printf 'US\nWashington\nRedmond\nNintendo of America Inc.\nNintendo Wifi Network\n*.*.*\nca@noa.nintendo.com\n\n\n' | \
  "$ssl" req -new -key server.key -out server.csr
"$ssl" x509 -req -in server.csr -CA nwc.crt -CAkey nwc.key -CAcreateserial \
  -out server.crt -days 3650 -sha1 -passin pass:alpine
cat server.crt nwc.crt > server_with_chain.crt
for file in server.key server.crt nwc.crt server_with_chain.crt; do cp "$file" "$output/$file"; done
