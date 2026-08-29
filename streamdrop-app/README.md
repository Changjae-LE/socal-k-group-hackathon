# StreamDrop Overlay MVP

Twitch 방송용 StreamDrop 오버레이 프로토타입입니다.

## 실행

```bash
npm install
npm run dev
```

일반 브라우저에서 `http://localhost:3000`을 열고 오버레이 미리보기를 선택합니다.

## 주소

- 개발 홈: `http://localhost:3000`
- 오버레이 미리보기: `http://localhost:3000/overlay?preview=1&controls=1`
- OBS 자동 데모: `http://localhost:3000/overlay?demo=1`
- 모바일 참여 프로토타입: `http://localhost:3000/join`

## OBS 설정

1. Sources에서 Browser Source를 추가합니다.
2. URL에 `http://localhost:3000/overlay?demo=1`을 입력합니다.
3. Width `1920`, Height `1080`을 사용합니다.
4. 브라우저의 미리보기 배경은 `preview=1`에서만 나타나므로 OBS에서는 방송 영상 위에 오버레이가 표시됩니다.

## 쿼리 옵션

- `preview=1`: 브라우저 확인용 가상 배경
- `controls=1`: 상태 전환 버튼
- `demo=1`: WAITING → OPEN → DRAWING → WINNER 자동 반복
- `state=open|waiting|drawing|winner`: 초기 상태
- `count=120`: 참여자 수
- `winner=SODA_FAN`: 당첨자 닉네임
- `join=https://example.com/join`: QR 코드가 가리킬 참여 주소

실제 휴대폰 참여용 QR에는 `localhost` 대신 추후 생성할 공개 Tunnel 주소를 넣어야 합니다.
