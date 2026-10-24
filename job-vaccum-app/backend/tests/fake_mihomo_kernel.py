"""Local test executable: controller and listeners, never an external proxy."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
from urllib.parse import unquote, urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-d', required=True)
    parser.add_argument('-f', required=True)
    parser.add_argument('-t', action='store_true')
    args = parser.parse_args()
    config = json.loads(Path(args.f).read_text())
    if args.t:
        return
    Path(args.d, 'kernel.pid').write_text(str(os.getpid()))
    listeners = []
    selected = {g['name']: g['proxies'][0] for g in config['proxy-groups']}
    class ProxyHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_CONNECT(self):
            # Never forward traffic. Exit verification fails locally.
            self.send_response(502)
            self.end_headers()
    for item in config['listeners']:
        listener = ThreadingHTTPServer((item['listen'], item['port']), ProxyHandler)
        listeners.append(listener)
        threading.Thread(target=listener.serve_forever, daemon=True).start()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            if self.headers.get('Authorization') != 'Bearer ' + config['secret']:
                self.send_response(401)
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            group = unquote(urlsplit(self.path).path.removeprefix('/proxies/'))
            value = {'version': 'synthetic'} if self.path == '/version' else {'now': selected[group]} if group in selected else {'delay': 20}
            self.wfile.write(json.dumps(value).encode())
        def do_PUT(self):
            value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            selected[unquote(self.path.removeprefix('/proxies/'))] = value['name']
            self.send_response(204)
            self.end_headers()
    host, port = config['external-controller'].split(':')
    with ThreadingHTTPServer((host, int(port)), Handler) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
