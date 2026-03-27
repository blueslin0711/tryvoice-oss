"""STT provider that delegates to Control Plane provider proxy."""

from __future__ import annotations

import aiohttp


class ProxySTTProvider:
    """Delegates STT to Control Plane /proxy/stt endpoint."""

    def __init__(self, base_url: str, token: str = ""):
        self._base_url = base_url.rstrip("/")
        self._token = token

    async def transcribe(self, audio_bytes: bytes, *, language: str = "auto") -> str:
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        async with aiohttp.ClientSession() as http:
            form = aiohttp.FormData()
            form.add_field("file", audio_bytes, filename="audio.webm", content_type="audio/webm")
            form.add_field("language", language)
            async with http.post(f"{self._base_url}/proxy/stt", headers=headers, data=form) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("text", "").strip()
                return ""

    def provider_name(self) -> str:
        return "proxy-stt"
