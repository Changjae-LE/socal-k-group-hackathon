# 🎁 StreamDrop

라이브 방송(Twitch) 시청자 대상 실시간 글로벌 기프트 추첨 MVP.
QR 스캔 → Twitch 로그인 → 참여 → 추첨 → SodaGift 상품 선택·주문 승인 → Twitch 귓속말 수령.

## 공개 Hosting (Firebase, 무료)

`raffle-app/hosting`을 Firebase 프로젝트 `hackathon-korean`의 Team5 Hosting 사이트에 올립니다. 휴대폰 참여는 localhost가 아니라 Firestore `events/live`로 바로 저장되고, 운영자/오버레이가 같은 문서를 구독합니다.

- 홈: https://hackathon-korean-team5.web.app
- 참여: https://hackathon-korean-team5.web.app/join
- 오버레이: https://hackathon-korean-team5.web.app/overlay
- 운영자: https://hackathon-korean-team5.web.app/admin?token=streamdrop

Twitch 콘솔 Redirect URL에는 `https://hackathon-korean-team5.web.app/join` (그리고 예비용 `/join/callback`)을 넣으세요. 로그인 성공 후 항상 이 공개 `/join`으로 돌아옵니다. localhost로 돌아오면 안 됩니다.

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

참가자 등록에는 Twitch 로그인이 반드시 필요합니다. SodaGift 키가 없을 때만 선물 링크가 mock 모드로 동작합니다.

## 폰에서 접속 (터널)
폰이 QR로 접속해야 하므로 공개 URL이 필요하다.
```bash
cloudflared tunnel --url http://localhost:8000
```
발급된 `https://xxx.trycloudflare.com`을:
1. `.env`의 `BASE_URL`에 넣고 서버 재시작 (QR·귓속말 링크에 반영)
2. 참가자 Twitch 로그인은 공개 Hosting `/join`으로 복귀합니다. Redirect URL에 `https://hackathon-korean-team5.web.app/join`을 등록하세요.

## Twitch 설정
1. https://dev.twitch.tv/console/apps 에서 앱 생성 → `TWITCH_CLIENT_ID` 설정
2. Redirect URL: `https://hackathon-korean-team5.web.app/join` (필수), `https://hackathon-korean-team5.web.app/join/callback` (예비)
3. 귓속말 발신 계정(전화번호 인증 필수)으로 토큰 발급:
   ```bash
   .venv/bin/python scripts/get_whisper_token.py
   ```
   브라우저에서 승인하면 `TWITCH_BOT_TOKEN`과 `TWITCH_BOT_USER_ID`가 로컬 `.env`에 저장됩니다.
   - 제한: 초당 3건, 미인증 계정은 하루 신규 수신자 ~40명. 수신자가 낯선 귓속말 차단 시 실패(폰 화면 표시가 보장 경로).

## SodaGift 설정 (sandbox)
1. sandbox 계정 → Settings > Developer Settings에서 API 키 발급 (`sodagift_test_...`)
2. `.env`의 `SODAGIFT_API_KEY`에 설정 → mock에서 실연동으로 자동 전환

- base URL: `https://biz-sandbox-api.sodagift.com`, 헤더 `SODA-API-KEY`
- 흐름: `GET /v1/products?country_code=XX&delivery_method=LINK` → 참가자에게 선택지 표시 → 참가자 승인 → `POST /v1/orders`(LINK, 멱등키) → `GET /v1/orders/{id}` 폴링 → `order_items[].delivery.link`
- `orders.log`에는 주문 식별 정보만 기록하며 수령 URL은 평문으로 저장하지 않음
- ⚠️ 수령 링크 보유자 = 수령자. API 키와 평문 링크는 Hosting/Firestore에 저장하지 않습니다.

### 공개 Firebase 당첨자에게 실제 LINK 지급

공개 운영자 화면에서 추첨하기 전에 로컬 Mac에서 지급 브리지를 실행하고 계속 켜 둡니다.

```bash
# 주문을 만들지 않고 현재 처리 대상만 확인
python scripts/fulfill_firestore_winners.py --dry-run

# 당첨 감지 → 상품 선택지 게시. 참가자 승인 후에만 주문·암호화 링크 전달
python scripts/fulfill_firestore_winners.py

# 오류 원인을 수정한 뒤 실패한 지급 1건 재시도
python scripts/fulfill_firestore_winners.py --once --retry-failed
```

참가자 브라우저는 참여 시 수령용 공개키를 Firestore에 등록하고 개인키를 해당 기기에만 보관합니다. 지급 브리지는 먼저 안전한 상품 정보만 게시하며 이 단계에서는 주문하지 않습니다. 당첨자가 상품을 선택하고 “선택한 선물 받기”를 누른 후에만 주문하고, SodaGift LINK를 암호화해 Firestore에 저장합니다. `--once`는 한 단계만 처리하므로 데모 운영에는 지급 브리지를 계속 실행하는 방식을 권장합니다.

현재 해커톤 Firestore 규칙은 공개 데모용입니다. 운영 서비스에서는 Firebase Authentication과 서버 전용 자격 증명으로 교체해야 합니다.

## 데모 시나리오
1. 지급 브리지 실행 → 공개 `/admin`에서 "이벤트 시작" → 오버레이에 QR 표시
2. 관객이 QR 스캔 → Twitch 로그인 → 국가 선택 → 참여 (오버레이 카운트 상승)
3. "추첨" 클릭 → 오버레이 당첨자 발표 + 지급 브리지가 SodaGift 상품 선택지 게시
4. 당첨자가 상품 선택 → “선택한 선물 받기” 클릭 → 이때 SodaGift 주문 생성
5. 로그인한 Twitch 계정의 귓속말 또는 “SodaGift에서 선물 받기” 버튼으로 API가 발급한 URL 열기
