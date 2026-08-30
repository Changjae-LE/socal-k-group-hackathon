"""참가자 플로우: Twitch OAuth 로그인 -> 국가 선택 -> 대기 -> 결과/수령."""
import logging
import secrets
import time

from fastapi import APIRouter, Form, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeSerializer

from app import config, state
from app.services import twitch
from app.web import templates
from app.ws import hub

log = logging.getLogger("streamdrop.join")
router = APIRouter()

_signer = URLSafeSerializer(config.SECRET_KEY, salt="sd-session")
_oauth_states: dict[str, float] = {}  # state -> 발급 시각 (10분 유효)

COOKIE = "sd_session"


def read_session(request: Request) -> dict | None:
    raw = request.cookies.get(COOKIE)
    if not raw:
        return None
    try:
        return _signer.loads(raw)
    except BadSignature:
        return None


def _set_session(response, data: dict) -> None:
    response.set_cookie(COOKIE, _signer.dumps(data), max_age=6 * 3600, httponly=True)


def _page_context(request: Request) -> dict:
    """join.html 렌더에 필요한 현재 상태."""
    sess = read_session(request)
    ev = state.current
    participant = ev.participants.get(sess["uid"]) if sess else None
    winner = None
    if sess and ev.status == "drawn":
        winner = next((w for w in ev.winners if w.twitch_user_id == sess["uid"]), None)
    return {
        "request": request,
        "session": sess,
        "event_status": ev.status,
        "joined": participant is not None,
        "participant": participant,
        "winner": winner,
        "is_loser": ev.status == "drawn" and participant is not None and winner is None,
        "countries": config.COUNTRIES,
        "twitch_ready": bool(config.TWITCH_CLIENT_ID),
        "debug": config.DEBUG,
    }


@router.get("/join", response_class=HTMLResponse)
async def join_page(request: Request):
    return templates.TemplateResponse(request, "join.html", _page_context(request))


@router.get("/join/login")
async def join_login():
    st = secrets.token_urlsafe(16)
    now = time.time()
    _oauth_states[st] = now
    for k, v in list(_oauth_states.items()):  # 오래된 state 정리
        if now - v > 600:
            _oauth_states.pop(k, None)
    return RedirectResponse(twitch.authorize_url(st))


@router.get("/join/callback", response_class=HTMLResponse)
async def join_callback():
    """Twitch may still have localhost /join/callback registered.

    The access token lives in the URL hash, which the server never sees,
    so bounce the browser to the public Hosting /join page and continue there.
    """
    dest = config.PUBLIC_JOIN_URL
    return HTMLResponse(
        f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>Returning…</title></head>
<body><script>
location.replace({dest!r} + location.search + location.hash);
</script></body></html>"""
    )


@router.get("/join/dev")
async def join_dev(nick: str = ""):
    """DEBUG 전용: OAuth 없이 가짜 참가자 세션 발급 (부하테스트/로컬데모)."""
    if not config.DEBUG:
        return RedirectResponse("/join")
    nick = nick or f"tester{secrets.token_hex(2)}"
    resp = RedirectResponse("/join")
    _set_session(resp, {"uid": f"dev{secrets.token_hex(4)}", "nick": nick})
    return resp


@router.post("/join/enter")
async def join_enter(request: Request, country: str = Form(...)):
    sess = read_session(request)
    if not sess:
        return RedirectResponse("/join", status_code=303)
    if country not in config.COUNTRY_CODES:
        return RedirectResponse("/join?error=country", status_code=303)
    async with state.lock:
        ev = state.current
        if ev.status != "open":
            return RedirectResponse("/join?error=closed", status_code=303)
        ev.participants[sess["uid"]] = state.Participant(
            twitch_user_id=sess["uid"], nickname=sess["nick"], country=country
        )
        summary = ev.summary()
    await hub.broadcast("overlay", summary)
    await hub.broadcast("admin", summary)
    return RedirectResponse("/join", status_code=303)


@router.websocket("/ws/join")
async def ws_join(ws: WebSocket):
    raw = ws.cookies.get(COOKIE)
    try:
        sess = _signer.loads(raw) if raw else None
    except BadSignature:
        sess = None
    if not sess:
        await ws.close(code=4401)
        return
    uid = sess["uid"]
    await hub.connect_participant(uid, ws)
    try:
        while True:
            await ws.receive_text()  # keepalive용, 내용 무시
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect_participant(uid, ws)


@router.get("/claim/{claim_id}", response_class=HTMLResponse)
async def claim_page(request: Request, claim_id: str):
    """mock 모드 수령 페이지 (sandbox 링크 시연 불가 시 대체용)."""
    return templates.TemplateResponse(request, "claim.html", {"claim_id": claim_id})
