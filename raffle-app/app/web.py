"""라우터가 공유하는 Jinja2 템플릿 인스턴스."""
from pathlib import Path

from fastapi.templating import Jinja2Templates

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
