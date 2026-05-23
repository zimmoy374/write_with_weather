from __future__ import annotations

import json
import mimetypes
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


PROJECT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_DIR / "frontend"
DB_DIR = Path(__file__).resolve().parent / "data"
DB_PATH = DB_DIR / "notes.sqlite3"
HOST = "127.0.0.1"
PORT = 8765


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                body_html TEXT NOT NULL DEFAULT '',
                weather TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(notes)").fetchall()
        }
        if "weather" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN weather TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_notes_position ON notes(position, updated_at)"
        )


def row_to_page(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body_html"],
        "weather": row["weather"],
        "position": row["position"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_pages() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, title, body_html, weather, position, created_at, updated_at
            FROM notes
            ORDER BY position ASC, updated_at ASC
            """
        ).fetchall()
    return [row_to_page(row) for row in rows]


def upsert_pages(pages: list[dict]) -> list[dict]:
    now = utc_now()
    with connect() as conn:
        for index, page in enumerate(pages):
            page_id = str(page.get("id") or "").strip()
            if not page_id:
                continue

            title = str(page.get("title") or "")
            body = str(page.get("body") or "")
            weather = str(page.get("weather") or "")
            conn.execute(
                """
                INSERT INTO notes (id, title, body_html, weather, position, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    body_html = excluded.body_html,
                    weather = excluded.weather,
                    position = excluded.position,
                    updated_at = excluded.updated_at
                """,
                (page_id, title, body, weather, index, now, now),
            )
    return list_pages()


def delete_page(page_id: str) -> list[dict]:
    with connect() as conn:
        conn.execute("DELETE FROM notes WHERE id = ?", (page_id,))
        rows = conn.execute(
            "SELECT id FROM notes ORDER BY position ASC, updated_at ASC"
        ).fetchall()
        for index, row in enumerate(rows):
            conn.execute(
                "UPDATE notes SET position = ?, updated_at = ? WHERE id = ?",
                (index, utc_now(), row["id"]),
            )
    return list_pages()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "SuixinNote/1.0"

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_common_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/pages":
            self.send_json({"pages": list_pages()})
            return

        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/pages/bulk":
            payload = self.read_json()
            pages = payload.get("pages") if isinstance(payload, dict) else []
            if not isinstance(pages, list):
                self.send_json({"error": "pages must be a list"}, status=400)
                return

            self.send_json({"pages": upsert_pages(pages)})
            return

        self.send_json({"error": "not found"}, status=404)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        prefix = "/api/pages/"
        if parsed.path.startswith(prefix):
            page_id = unquote(parsed.path[len(prefix) :])
            if not page_id:
                self.send_json({"error": "missing page id"}, status=400)
                return

            self.send_json({"pages": delete_page(page_id)})
            return

        self.send_json({"error": "not found"}, status=404)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}

        raw = self.rfile.read(length).decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def serve_static(self, request_path: str) -> None:
        clean_path = unquote(request_path).lstrip("/")
        file_path = FRONTEND_DIR / (clean_path or "index.html")
        if file_path.is_dir():
            file_path = file_path / "index.html"

        try:
            resolved = file_path.resolve()
            resolved.relative_to(FRONTEND_DIR)
        except ValueError:
            self.send_json({"error": "forbidden"}, status=403)
            return

        if not resolved.exists() or not resolved.is_file():
            self.send_json({"error": "not found"}, status=404)
            return

        content_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        data = resolved.read_bytes()
        self.send_response(200)
        self.send_common_headers(content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_common_headers("application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_common_headers(self, content_type: str | None = None) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if content_type:
            self.send_header("Content-Type", content_type)

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


def main() -> None:
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)
    print(f"Serving 随心一记 at http://{HOST}:{PORT}/")
    print(f"SQLite database: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
