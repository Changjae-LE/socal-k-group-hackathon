# 🎁 StreamDrop

라이브 방송(Twitch) 시청자 대상 실시간 글로벌 기프트 추첨 MVP.
QR 스캔 → Twitch 로그인 참여 → 추첨 → 당첨자 폰 + Twitch 귓속말로 SodaGift 수령 링크 즉시 지급.

## 공개 Hosting (Firebase, 무료)

`raffle-app/hosting`을 `hackathon-korean` Firebase Hosting에 올립니다. 휴대폰 참여는 localhost가 아니라 Firestore `events/live`로 바로 저장되고, 운영자/오버레이가 같은 문서를 구독합니다.

- 홈: https://hackathon-korean.web.app
- 참여: https://hackathon-korean.web.app/join
- 오버레이: https://hackathon-korean.web.app/overlay
- 운영자: https://hackathon-korean.web.app/admin?token=streamdrop

Twitch 콘솔 앱의 Redirect URL에 `https://hackathon-korean.web.app/join`을 넣은 뒤 `raffle-app/hosting/js/firebase-config.js`의 `STREAMDROP_TWITCH_CLIENT_ID`를 채우면 공개 참여 화면에 Twitch 로그인이 켜집니다.

```bash
npx firebase deploy --only hosting,firestore --project hackathon-korean
```

로컬 Python 서버는 Twitch OAuth·SodaGift API용입니다. 공개 QR 데모는 Hosting URL을 사용하세요.

## 화면
| 라우트 | 용도 |
|---|---|
| `/overlay` | OBS 브라우저 소스: QR·참여 인원·당첨자 발표 |
| `/join` | 참가자 모바일: Twitch 로그인, 국가 선택, 결과·수령 |
| `/admin?token=<ADMIN_TOKEN>` | 운영자: 시작/추첨/초기화, 지급 현황 |

## 실행
```bash
# Python 3.10+ 필요 (macOS 기본 3.8 불가 — brew python3.12 권장)
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 값 채우기
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

키 없이도 바로 데모 가능: SodaGift 미설정 → mock 링크, Twitch 미설정 → `DEBUG=1`일 때 `/join/dev`로 가짜 참여.

```bash
# 가짜 참가자 20명
python scripts/fake_join.py 20
```

## 폰에서 접속 (터널)
폰이 QR로 접속해야 하므로 공개 URL이 필요하다.
```bash
cloudflared tunnel --url http://localhost:8000
```
발급된 `https://xxx.trycloudflare.com`을:
1. `.env`의 `BASE_URL`에 넣고 서버 재시작 (QR·귓속말 링크에 반영)
2. Twitch 개발자 콘솔 앱의 OAuth Redirect URL에 `{BASE_URL}/join/callback` 등록

## Twitch 설정
1. https://dev.twitch.tv/console/apps 에서 앱 생성 → `TWITCH_CLIENT_ID/SECRET`
2. Redirect URL: `{BASE_URL}/join/callback`
3. 귓속말 발신 계정(전화번호 인증 필수)으로 토큰 발급:
   ```bash
   twitch token -u -s user:manage:whispers
   ```
   → `TWITCH_BOT_TOKEN`, 계정 ID → `TWITCH_BOT_USER_ID`
   - 제한: 초당 3건, 미인증 계정은 하루 신규 수신자 ~40명. 수신자가 낯선 귓속말 차단 시 실패(폰 화면 표시가 보장 경로).

## SodaGift 설정 (sandbox)
1. sandbox 계정 → Settings > Developer Settings에서 API 키 발급 (`sodagift_test_...`)
2. `.env`의 `SODAGIFT_API_KEY`에 설정 → mock에서 실연동으로 자동 전환
- base URL: `https://biz-sandbox-api.sodagift.com`, 헤더 `SODA-API-KEY`
- 흐름: `GET /v1/products?country_code=XX&delivery_method=LINK` → 최저가 ON_SALE 상품 → `POST /v1/orders`(LINK, 멱등키) → `GET /v1/orders/{id}` 폴링 → `order_items[].delivery.link`
- 발급된 링크는 `orders.log`에도 기록됨 (지급 사고 대비)
- ⚠️ 수령 링크 보유자 = 수령자. overlay/admin에 절대 노출하지 않음 (참가자 본인 WS·귓속말로만 전달)

## 데모 시나리오
1. `/admin` → "이벤트 시작" → 오버레이에 QR 표시
2. 관객이 QR 스캔 → Twitch 로그인 → 국가 선택 → 참여 (오버레이 카운트 상승)
3. "추첨" 클릭 → 오버레이 당첨자 발표 + 각자 폰에 당첨/낙첨 표시
4. 당첨자 폰에 수령 버튼 등장 (+ 귓속말 도착)
