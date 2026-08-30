function sdPublicUrl() {
  return (window.STREAMDROP_PUBLIC_URL || "https://hackathon-korean.web.app").replace(/\/$/, "");
}

function sdJoinUrl() {
  return window.STREAMDROP_TWITCH_REDIRECT_URI || `${sdPublicUrl()}/join`;
}

function sdSendTwitchReturnToPublicJoin() {
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
  return sdDb().doc("events/live");
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
  return Object.entries(data.participants || {}).map(([uid, p]) => ({ uid, ...p }));
}

function sdJoinedList(data) {
  return sdParticipantList(data).filter((p) => p.country);
}

async function sdWriteParticipant(uid, fields) {
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
      twitch: Boolean(fields.twitch || prev.twitch),
      claimPublicKey: fields.claimPublicKey || prev.claimPublicKey || null,
    };
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
