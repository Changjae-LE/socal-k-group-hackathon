"use client";

import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";

type EventState = "WAITING" | "OPEN" | "DRAWING" | "WINNER";

const orderedStates: EventState[] = ["WAITING", "OPEN", "DRAWING", "WINNER"];

const stateLabels: Record<EventState, string> = {
  WAITING: "READY",
  OPEN: "OPEN NOW",
  DRAWING: "DRAWING",
  WINNER: "WINNER",
};

function Brand() {
  return (
    <div className="overlay-brand" aria-label="StreamDrop">
      <span className="brand-mark">S</span>
      <div>
        <strong>StreamDrop</strong>
        <small>LIVE GLOBAL REWARDS</small>
      </div>
    </div>
  );
}

function QrCard({ joinUrl }: { joinUrl: string }) {
  const [qrData, setQrData] = useState("");

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(joinUrl, {
      width: 520,
      margin: 1,
      errorCorrectionLevel: "H",
      color: { dark: "#141326", light: "#ffffff" },
    }).then((value) => active && setQrData(value));
    return () => {
      active = false;
    };
  }, [joinUrl]);

  return (
    <aside className="qr-card">
      <span className="qr-eyebrow">SCAN TO JOIN</span>
      <div className="qr-frame">
        {qrData ? <img src={qrData} alt="StreamDrop 참여 QR 코드" /> : <div className="qr-loading" />}
        <span className="qr-corner qr-corner-one" />
        <span className="qr-corner qr-corner-two" />
        <span className="qr-corner qr-corner-three" />
        <span className="qr-corner qr-corner-four" />
      </div>
      <strong>휴대폰으로 참여하기</strong>
      <span className="qr-url">{joinUrl.replace(/^https?:\/\//, "")}</span>
    </aside>
  );
}

function WaitingView() {
  return (
    <section className="state-copy waiting-copy">
      <span className="event-kicker">NEXT REWARD DROP</span>
      <h1>팬 리워드가<br />곧 시작됩니다.</h1>
      <p>채팅과 화면을 주목해 주세요.</p>
      <div className="waiting-pulse"><span /></div>
    </section>
  );
}

function OpenView({ participantCount }: { participantCount: number }) {
  return (
    <section className="state-copy open-copy">
      <span className="event-kicker">GLOBAL FAN REWARD</span>
      <h1>지금 바로<br /><em>StreamDrop!</em></h1>
      <p>QR을 스캔하고 닉네임만 입력하면 참여 완료.</p>
      <div className="participant-pill">
        <span className="people-icon">●</span>
        <div>
          <small>LIVE PARTICIPANTS</small>
          <strong>{participantCount.toLocaleString()}명 참여 중</strong>
        </div>
      </div>
    </section>
  );
}

function DrawingView() {
  return (
    <section className="drawing-view">
      <div className="draw-orbit">
        <span className="orbit-dot orbit-dot-one" />
        <span className="orbit-dot orbit-dot-two" />
        <span className="orbit-dot orbit-dot-three" />
        <div className="draw-core">?</div>
      </div>
      <span className="event-kicker">ONE LUCKY FAN</span>
      <h1>당첨자를<br />뽑고 있어요!</h1>
      <p>두근두근, 잠시만 기다려 주세요.</p>
    </section>
  );
}

function WinnerView({ winnerName }: { winnerName: string }) {
  return (
    <section className="winner-view">
      <div className="confetti confetti-one" />
      <div className="confetti confetti-two" />
      <div className="confetti confetti-three" />
      <span className="winner-trophy">★</span>
      <span className="event-kicker">CONGRATULATIONS</span>
      <h1>{winnerName}</h1>
      <p>오늘의 StreamDrop 당첨자입니다!</p>
      <div className="winner-gift">
        <span>GIFT READY</span>
        <strong>Powered by SodaGift</strong>
      </div>
    </section>
  );
}

export default function OverlayPage() {
  const [eventState, setEventState] = useState<EventState>("OPEN");
  const [participantCount, setParticipantCount] = useState(38);
  const [winnerName, setWinnerName] = useState("SODA_FAN_17");
  const [joinUrl, setJoinUrl] = useState("http://localhost:3000/join");
  const [preview, setPreview] = useState(false);
  const [controls, setControls] = useState(false);
  const [autoDemo, setAutoDemo] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedState = params.get("state")?.toUpperCase() as EventState | undefined;
    if (requestedState && orderedStates.includes(requestedState)) setEventState(requestedState);
    if (params.get("count")) setParticipantCount(Number(params.get("count")) || 38);
    if (params.get("winner")) setWinnerName(params.get("winner") || "SODA_FAN_17");
    setJoinUrl(params.get("join") || process.env.NEXT_PUBLIC_JOIN_URL || `${window.location.origin}/join`);
    setPreview(params.get("preview") === "1");
    setControls(params.get("controls") === "1");
    setAutoDemo(params.get("demo") === "1");
  }, []);

  useEffect(() => {
    if (!autoDemo) return;

    const updateDemo = () => {
      const second = Math.floor(Date.now() / 1000) % 24;
      if (second < 3) {
        setEventState("WAITING");
        setParticipantCount(38);
      } else if (second < 14) {
        setEventState("OPEN");
        setParticipantCount(38 + (second - 3) * 3);
      } else if (second < 18) {
        setEventState("DRAWING");
      } else {
        setEventState("WINNER");
      }
    };

    updateDemo();
    const timer = window.setInterval(updateDemo, 500);
    return () => window.clearInterval(timer);
  }, [autoDemo]);

  const nextState = useMemo(() => {
    const currentIndex = orderedStates.indexOf(eventState);
    return orderedStates[(currentIndex + 1) % orderedStates.length];
  }, [eventState]);

  return (
    <main className={`overlay-page ${preview ? "overlay-preview" : ""}`}>
      <div className="overlay-vignette" />
      <header className="overlay-header">
        <Brand />
        <div className="live-badge"><span /> LIVE ON TWITCH</div>
      </header>

      <div className="status-chip">
        <span className={`status-dot status-${eventState.toLowerCase()}`} />
        {stateLabels[eventState]}
      </div>

      <div className="overlay-content">
        {eventState === "WAITING" && <WaitingView />}
        {eventState === "OPEN" && <OpenView participantCount={participantCount} />}
        {eventState === "DRAWING" && <DrawingView />}
        {eventState === "WINNER" && <WinnerView winnerName={winnerName} />}
        {eventState === "OPEN" && <QrCard joinUrl={joinUrl} />}
      </div>

      <footer className="overlay-footer">
        <span>Instant rewards for fans everywhere</span>
        <span className="powered-by">POWERED BY <strong>SodaGift</strong></span>
      </footer>

      {controls && (
        <nav className="demo-controls" aria-label="오버레이 데모 컨트롤">
          {orderedStates.map((state) => (
            <button
              key={state}
              className={eventState === state ? "active" : ""}
              onClick={() => {
                setAutoDemo(false);
                setEventState(state);
              }}
            >
              {stateLabels[state]}
            </button>
          ))}
          <button onClick={() => setEventState(nextState)}>NEXT</button>
          <button className={autoDemo ? "active" : ""} onClick={() => setAutoDemo((value) => !value)}>
            AUTO
          </button>
        </nav>
      )}
    </main>
  );
}
