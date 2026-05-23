from __future__ import annotations

import json
import mimetypes
from pathlib import Path

from google import genai
from google.genai import types
from sqlmodel import Session

from .database import engine
from .models import Card, utc_now
from .settings import settings


TEXT_PROMPT = """
你是一个灵感剪切板助手。请根据用户粘贴的文本，提炼一句不超过 40 字的中文总结，
并给出 5 到 10 个短关键词。关键词要像灵感标签，清晰、可复用、不要太正式。
只返回 JSON，格式为 {"summary":"...","keywords":["..."]}。
"""

IMAGE_PROMPT = """
你是一个视觉灵感剪切板助手。请观察图片里的画面、文字、布局、色彩和设计风格，
提炼一句不超过 40 字的中文总结，并给出 5 到 10 个短关键词。
关键词要像灵感标签，清晰、可复用、不要太正式。
只返回 JSON，格式为 {"summary":"...","keywords":["..."]}。
"""


def _clean_json(text: str) -> dict:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`").strip()
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end != -1:
        stripped = stripped[start : end + 1]
    return json.loads(stripped)


def _normalize_result(payload: dict) -> tuple[str, list[str]]:
    summary = str(payload.get("summary") or "").strip()
    raw_keywords = payload.get("keywords") or []
    keywords = []
    for item in raw_keywords:
        keyword = str(item).strip()
        if keyword and keyword not in keywords:
            keywords.append(keyword)
    return summary[:120], keywords[:10]


def analyze_card(card_id: str) -> None:
    with Session(engine) as session:
        card = session.get(Card, card_id)
        if not card:
            return

        if not settings.gemini_api_key:
            card.ai_status = "failed"
            card.ai_error = "GEMINI_API_KEY 未配置"
            card.updated_at = utc_now()
            session.add(card)
            session.commit()
            return

        card.ai_status = "generating"
        card.ai_error = None
        card.updated_at = utc_now()
        session.add(card)
        session.commit()

        try:
            client = genai.Client(api_key=settings.gemini_api_key)
            contents: list[object] = []
            if card.type == "image":
                if not card.image_filename:
                    raise ValueError("图片文件不存在")
                image_path = Path(settings.upload_dir) / card.image_filename
                mime_type = mimetypes.guess_type(image_path.name)[0] or "image/png"
                contents = [
                    IMAGE_PROMPT,
                    types.Part.from_bytes(data=image_path.read_bytes(), mime_type=mime_type),
                ]
            else:
                contents = [TEXT_PROMPT, card.text_content or ""]

            response = client.models.generate_content(
                model=settings.gemini_model,
                contents=contents,
                config=types.GenerateContentConfig(response_mime_type="application/json"),
            )
            payload = _clean_json(response.text or "{}")
            summary, keywords = _normalize_result(payload)
            if not summary and not keywords:
                raise ValueError("AI 返回为空")

            card = session.get(Card, card_id)
            if not card:
                return
            card.summary = summary
            card.keywords = keywords
            card.ai_status = "done"
            card.ai_error = None
            card.updated_at = utc_now()
            session.add(card)
            session.commit()
        except Exception as exc:
            card = session.get(Card, card_id)
            if not card:
                return
            card.ai_status = "failed"
            card.ai_error = str(exc)[:240]
            card.updated_at = utc_now()
            session.add(card)
            session.commit()
