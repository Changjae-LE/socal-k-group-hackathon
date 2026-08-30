function sdPublicUrl() {
  return (window.STREAMDROP_PUBLIC_URL || "https://hackathon-korean-team5.web.app").replace(/\/$/, "");
}

function sdJoinUrl() {
  return window.STREAMDROP_TWITCH_REDIRECT_URI || `${sdPublicUrl()}/join`;
}

function sdSendTwitchReturnToPublicJoin() {
  // ?local=1 이면 localhost에서도 리다이렉트하지 않음 (로컬 UI 테스트용)
  if (new URLSearchParams(location.search).has("local")) return false;
  const publicJoin = sdJoinUrl();
  const here = `${location.origin}${location.pathname}`.replace(/\/$/, "");
  const onLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const hasToken = location.hash.includes("access_token");
  const hasCode = /[?&]code=/.test(location.search);
  if (onLocal || ((hasToken || hasCode) && here !== publicJoin)) {
    location.replace(publicJoin + location.search + location.hash);
    return true;
  }
  return false;
}

function sdDb() {
  if (!firebase.apps.length) firebase.initializeApp(window.STREAMDROP_FIREBASE);
  return firebase.firestore();
}

function sdEventRef() {
  // 로컬/통합 테스트용: window.STREAMDROP_EVENT_DOC로 별도 문서 지정 가능
  return sdDb().doc(window.STREAMDROP_EVENT_DOC || "events/live");
}

function sdEmptyEvent() {
  return {
    status: "idle",
    eventId: Math.random().toString(16).slice(2, 10),
    participants: {},
    winners: [],
    updatedAt: Date.now(),
  };
}

async function sdEnsureEvent() {
  const ref = sdEventRef();
  const snap = await ref.get();
  if (!snap.exists) await ref.set(sdEmptyEvent());
  return ref;
}

function sdParticipantList(data) {
  return Object.entries(data.participants || {})
    .map(([uid, p]) => ({ uid, ...p }))
    .filter((p) => p.twitch === true && /^\d+$/.test(String(p.uid || "")));
}

function sdJoinedList(data) {
  return sdParticipantList(data).filter(
    (p) => p.twitch === true && /^\d+$/.test(String(p.uid || "")) && p.country && p.claimPublicKey,
  );
}

async function sdWriteParticipant(uid, fields) {
  if (fields.twitch !== true || !/^\d+$/.test(String(uid || ""))) {
    throw new Error("Twitch 계정으로 로그인해야 참여할 수 있습니다.");
  }
  const ref = sdEventRef();
  return sdDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || sdEmptyEvent()) : sdEmptyEvent();
    const participants = { ...(data.participants || {}) };
    const prev = participants[uid] || {};
    const next = {
      nickname: fields.nickname || prev.nickname || "",
      country: fields.country || prev.country || "",
      joinedAt: prev.joinedAt || Date.now(),
      twitch: true,
      claimPublicKey: fields.claimPublicKey || prev.claimPublicKey || null,
      // AI 추천용 취향 프로필 (팔로우 채널 + 카테고리)
      tasteProfile: fields.tasteProfile || prev.tasteProfile || null,
    };
    if (prev.recs) next.recs = prev.recs;
    if (prev.recsStatus) next.recsStatus = prev.recsStatus;
    participants[uid] = next;
    const status = next.country && data.status !== "drawn" ? "open" : (data.status || "idle");
    const written = {
      status,
      eventId: data.eventId || sdEmptyEvent().eventId,
      participants,
      winners: data.winners || [],
      updatedAt: Date.now(),
    };
    tx.set(ref, written, { merge: true });
    return written;
  });
}

function sdListenEvent(onData, onError) {
  return sdEventRef().onSnapshot(
    (snap) => onData(snap.exists ? snap.data() : sdEmptyEvent()),
    (err) => {
      console.error("Firestore listen failed", err);
      if (onError) onError(err);
    },
  );
}
