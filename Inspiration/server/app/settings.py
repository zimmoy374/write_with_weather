from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")
load_dotenv(ROOT_DIR / "server" / ".env")


def _data_dir() -> Path:
    raw_value = os.getenv("INSPIRATION_DATA_DIR")
    path = Path(raw_value) if raw_value else ROOT_DIR / ".data"
    return path if path.is_absolute() else ROOT_DIR / path


class Settings:
    root_dir: Path = ROOT_DIR
    data_dir: Path = _data_dir()
    upload_dir: Path = data_dir / "uploads"
    database_url: str = f"sqlite:///{data_dir / 'inspiration.sqlite'}"
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
    max_upload_bytes: int = 10 * 1024 * 1024


settings = Settings()
