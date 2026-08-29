"""StreamDrop — 라이브 방송 실시간 리워드 MVP."""
import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.routes import admin, join, overlay

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

app = FastAPI(title="StreamDrop")
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")
app.include_router(join.router)
app.include_router(admin.router)
app.include_router(overlay.router)


@app.get("/")
async def index():
    return RedirectResponse("/join")
