"""OBS 오버레이: QR + 참여 인원 + 당첨자 발표."""
import io

import qrcode
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, Response

from app import config, state
from app.web import templates
from app.ws import hub

router = APIRouter()


@router.get("/overlay", response_class=HTMLResponse)
async def overlay_page(request: Request):
    return templates.TemplateResponse(request, "overlay.html", {
        "join_url": f"{config.BASE_URL}/join",
    })


@router.get("/qr.png")
async def qr_png():
    img = qrcode.make(f"{config.BASE_URL}/join", box_size=12, border=1)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@router.websocket("/ws/overlay")
async def ws_overlay(ws: WebSocket):
    await hub.connect_channel("overlay", ws)
    ev = state.current
    try:
        await ws.send_json(ev.summary())
        if ev.status == "drawn":
            await ws.send_json({"type": "winners",
                                "winners": [w.public() for w in ev.winners],
                                "count": len(ev.participants)})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect_channel("overlay", ws)
