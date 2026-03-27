"""TTS provider that delegates to Control Plane provider proxy."""

from __future__ import annotations

import aiohttp


class ProxyTTSProvider:
    """Delegates TTS to Control Plane /proxy/tts endpoint."""

    def __init__(self, base_url: str, token: str = ""):
        self._base_url = base_url.rstrip("/")
        self._token = token

    async def synthesize(self, text: str, *, voice: str | None = None, rate: str = "1.0") -> bytes:
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        payload: dict = {"text": text, "rate": rate}
        if voice:
            payload["voice"] = voice
        async with aiohttp.ClientSession() as http:
            async with http.post(f"{self._base_url}/proxy/tts", headers=headers, json=payload) as resp:
                if resp.status == 200:
                    return await resp.read()
                return b""

    def provider_name(self) -> str:
        return "proxy-tts"
