"""운영자: 이벤트 시작/추첨/리셋 + 당첨자 지급 파이프라인."""
import asyncio
import logging

from fastapi import APIRouter, Body, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.responses import PlainTextResponse

from app import config, state
from app.services import sodagift, twitch
from app.services.draw import draw_winners
from app.web import templates
from app.ws import hub

log = logging.getLogger("streamdrop.admin")
router = APIRouter()

WHISPER_INTERVAL = 1.2  # 초당 3건 제한 대비 여유 간격


def _authorized(request: Request) -> bool:
    token = request.query_params.get("token") or request.headers.get("x-admin-token")
    return token == config.ADMIN_TOKEN


async def _push_admin_state() -> None:
    ev = state.current
    await hub.broadcast("admin", {
        **ev.summary(),
        "participants": [p.public() for p in ev.participants.values()],
        "winners": [w.admin_view() for w in ev.winners],
    })


@router.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request):
    if not _authorized(request):
        return PlainTextResponse("forbidden: /admin?token=<ADMIN_TOKEN>", status_code=403)
    return templates.TemplateResponse(request, "admin.html", {
        "token": config.ADMIN_TOKEN,
        "mock": sodagift.mock_mode(),
        "whisper_ready": bool(config.TWITCH_BOT_TOKEN and config.TWITCH_BOT_USER_ID),
    })


@router.post("/admin/start")
async def admin_start(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    async with state.lock:
        state.current.status = "open"
        summary = state.current.summary()
    await hub.broadcast("overlay", summary)
    await hub.broadcast_participants(summary)
    await _push_admin_state()
    return {"ok": True}


@router.post("/admin/reset")
async def admin_reset(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    async with state.lock:
        state.reset()
        sodagift.clear_cache()
        summary = state.current.summary()
    await hub.broadcast("overlay", {**summary, "reset": True})
    await hub.broadcast_participants({"type": "reset"})
    await _push_admin_state()
    return {"ok": True}


@router.post("/admin/draw")
async def admin_draw(request: Request, payload: dict = Body(default={})):
    if not _authorized(request):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    count = int(payload.get("count", 1))
    async with state.lock:
        ev = state.current
        if ev.status != "open":
            return JSONResponse({"error": f"cannot draw in status '{ev.status}'"}, status_code=400)
        if not ev.participants:
            return JSONResponse({"error": "no participants"}, status_code=400)
        ev.winners = draw_winners(ev.participants, count)
        ev.status = "drawn"
        winner_ids = {w.twitch_user_id for w in ev.winners}

    # 1) 즉시 발표 (선물 준비 전에 연출부터)
    await hub.broadcast("overlay", {
        "type": "winners",
        "winners": [w.public() for w in state.current.winners],
        "count": len(state.current.participants),
    })
    for uid, p in state.current.participants.items():
        await hub.send_participant(uid, {"type": "result", "won": uid in winner_ids})
    await _push_admin_state()

    # 2) 백그라운드 지급
    asyncio.create_task(_fulfill_winners())
    return {"ok": True, "winners": len(winner_ids)}


async def _fulfill_winners() -> None:
    ev = state.current
    for w in ev.winners:
        try:
            w.status = "ordering"
            await _push_admin_state()
            ref_id = f"sd{ev.event_id}{w.twitch_user_id}"  # 영숫자만 (멱등키)
            ref_id = "".join(ch for ch in ref_id if ch.isalnum())[:100]
            result = await sodagift.get_gift_link(w.nickname, w.country, ref_id)
            w.order_id = result["order_id"]
            w.product_name = result["product_name"]
            w.gift_link = result["link"]
            w.status = "link_ready"
            # 보장 경로: 참가자 폰으로 push
            await hub.send_participant(w.twitch_user_id, {
                "type": "gift",
                "product_name": w.product_name,
                "link": w.gift_link,
            })
        except Exception as e:
            log.exception("fulfillment failed for %s", w.nickname)
            w.status = "failed"
            w.error = str(e)[:200]
            await _push_admin_state()
            continue

        # best-effort 귓속말 (dev 참가자는 실계정이 아니므로 스킵)
        if w.twitch_user_id.isdigit() and config.TWITCH_BOT_TOKEN:
            w.whisper_status = "sending"
            await _push_admin_state()
            try:
                await twitch.send_whisper(
                    w.twitch_user_id,
                    f"🎁 StreamDrop: {w.nickname}, you won! Claim your {w.product_name}: "
                    f"{w.gift_link} (Do not share this link — it is your gift.)",
                )
                w.whisper_status = "sent"
            except Exception as e:
                log.warning("whisper failed for %s: %s", w.nickname, e)
                w.whisper_status = "failed"
            await asyncio.sleep(WHISPER_INTERVAL)
        await _push_admin_state()


@router.websocket("/ws/admin")
async def ws_admin(ws: WebSocket):
    if ws.query_params.get("token") != config.ADMIN_TOKEN:
        await ws.close(code=4403)
        return
    await hub.connect_channel("admin", ws)
    await _push_admin_state()
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect_channel("admin", ws)
