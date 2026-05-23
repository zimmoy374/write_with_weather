from __future__ import annotations

import threading
import webbrowser
from http.server import ThreadingHTTPServer
from sys import argv

from backend.server import DB_PATH, HOST, PORT, RequestHandler, init_db


def main() -> None:
    init_db()
    url = f"http://{HOST}:{PORT}/"
    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)

    print(f"Serving 随心一记 at {url}")
    print(f"SQLite database: {DB_PATH}")
    print("Press Ctrl+C to stop.")

    if "--no-browser" not in argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
