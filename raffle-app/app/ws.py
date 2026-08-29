"""WebSocket 허브. overlay/admin 채널 broadcast + 참가자(uid별) 개인 push."""
import json
import logging

from fastapi import WebSocket

log = logging.getLogger("streamdrop.ws")


class Hub:
    def __init__(self) -> None:
        self.channels: dict[str, set[WebSocket]] = {"overlay": set(), "admin": set()}
        self.participants: dict[str, set[WebSocket]] = {}

    async def connect_channel(self, name: str, ws: WebSocket) -> None:
        await ws.accept()
        self.channels[name].add(ws)

    def disconnect_channel(self, name: str, ws: WebSocket) -> None:
        self.channels[name].discard(ws)

    async def connect_participant(self, uid: str, ws: WebSocket) -> None:
        await ws.accept()
        self.participants.setdefault(uid, set()).add(ws)

    def disconnect_participant(self, uid: str, ws: WebSocket) -> None:
        conns = self.participants.get(uid)
        if conns:
            conns.discard(ws)
            if not conns:
                self.participants.pop(uid, None)

    async def _send(self, ws: WebSocket, text: str) -> bool:
        try:
            await ws.send_text(text)
            return True
        except Exception:
            return False

    async def broadcast(self, channel: str, message: dict) -> None:
        text = json.dumps(message)
        dead = [ws for ws in self.channels[channel] if not await self._send(ws, text)]
        for ws in dead:
            self.channels[channel].discard(ws)

    async def send_participant(self, uid: str, message: dict) -> None:
        text = json.dumps(message)
        for ws in list(self.participants.get(uid, ())):
            if not await self._send(ws, text):
                self.disconnect_participant(uid, ws)

    async def broadcast_participants(self, message: dict) -> None:
        for uid in list(self.participants):
            await self.send_participant(uid, message)


hub = Hub()
