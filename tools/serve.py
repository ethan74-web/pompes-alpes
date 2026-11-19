"""Serveur local de mise au point : sert le dossier site/ sans cache.   python site/tools/serve.py [port]"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


Handler.extensions_map.update({".js": "text/javascript", ".json": "application/json"})
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
http.server.ThreadingHTTPServer.request_queue_size = 256   # file d'attente plus longue : Windows coupait des connexions
http.server.ThreadingHTTPServer.daemon_threads = True
srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=ROOT))
print(f"http://localhost:{port}", flush=True)
srv.serve_forever()
