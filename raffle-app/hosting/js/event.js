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

function sdListenEvent(onData) {
  return sdEventRef().onSnapshot((snap) => {
    onData(snap.exists ? snap.data() : sdEmptyEvent());
  });
}
