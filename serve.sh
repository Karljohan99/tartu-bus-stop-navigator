#!/bin/bash
# Serve the app. Phones only give location to HTTPS pages, so by default this serves HTTPS with a
# self-signed certificate (accept the browser warning once).  ./serve.sh [port]   |   HTTP=1 ./serve.sh
cd "$(dirname "$0")"
PORT=${1:-8443}
if [ -n "$HTTP" ]; then exec python3 -m http.server "$PORT" --directory web; fi
[ -f build/cert.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=tartu-nav" \
  -keyout build/key.pem -out build/cert.pem 2>/dev/null
echo "Open on the phone (same network):"; for ip in $(hostname -I); do echo "  https://$ip:$PORT/"; done
exec python3 - "$PORT" <<'PY'
import http.server, ssl, sys, functools
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory='web')
s = http.server.ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1])), h)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain('build/cert.pem', 'build/key.pem')
s.socket = ctx.wrap_socket(s.socket, server_side=True)
s.serve_forever()
PY
