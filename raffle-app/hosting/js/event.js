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
  await sdEnsureEvent();
  const snap = await sdEventRef().get();
  const data = snap.data() || sdEmptyEvent();
  const prev = (data.participants || {})[uid] || {};
  await sdEventRef().set({
    [`participants.${uid}`]: {
      nickname: fields.nickname || prev.nickname || "",
      country: fields.country || prev.country || "",
      joinedAt: prev.joinedAt || Date.now(),
      twitch: Boolean(fields.twitch || prev.twitch),
    },
    updatedAt: Date.now(),
  }, { merge: true });
  return data.eventId;
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
