import Link from "next/link";

export default function HomePage() {
  return (
    <main className="home-page">
      <section className="home-card">
        <div className="brand-lockup brand-lockup-dark">
          <span className="brand-mark">S</span>
          <span>StreamDrop</span>
        </div>
        <p className="home-kicker">TWITCH × SODAGIFT</p>
        <h1>라이브 순간을<br />전 세계 팬의 선물로.</h1>
        <p className="home-copy">
          방송 오버레이 프로토타입입니다. 미리보기에서는 이벤트 상태를 직접 바꿔볼 수 있습니다.
        </p>
        <div className="home-actions">
          <Link className="primary-button" href="/overlay?preview=1&controls=1">
            오버레이 미리보기
          </Link>
          <Link className="secondary-button" href="/join">
            모바일 참여 화면
          </Link>
        </div>
        <div className="home-note">
          OBS용 주소 <code>http://localhost:3000/overlay?demo=1</code>
        </div>
      </section>
    </main>
  );
}
