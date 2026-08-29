"use client";

import { FormEvent, useState } from "react";

export default function JoinPage() {
  const [joined, setJoined] = useState(false);
  const [nickname, setNickname] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (nickname.trim().length >= 2) setJoined(true);
  }

  return (
    <main className="join-page">
      <section className="join-card">
        <div className="brand-lockup brand-lockup-dark">
          <span className="brand-mark">S</span>
          <span>StreamDrop</span>
        </div>
        {!joined ? (
          <>
            <p className="join-kicker">LIVE FAN REWARD</p>
            <h1>방송을 보며<br />선물에 도전하세요.</h1>
            <p className="join-description">닉네임과 국가만 선택하면 바로 참여할 수 있어요.</p>
            <form onSubmit={submit}>
              <label>
                닉네임
                <input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  minLength={2}
                  maxLength={20}
                  placeholder="방송에서 사용할 닉네임"
                  required
                />
              </label>
              <label>
                국가
                <select defaultValue="KR">
                  <option value="KR">대한민국</option>
                  <option value="US">United States</option>
                </select>
              </label>
              <button type="submit">이벤트 참여하기</button>
            </form>
          </>
        ) : (
          <div className="joined-view">
            <span className="joined-check">✓</span>
            <p className="join-kicker">YOU&apos;RE IN</p>
            <h1>참여 완료!</h1>
            <p><strong>{nickname}</strong>님, 방송에서 추첨 결과를 기다려 주세요.</p>
            <div className="joined-status"><span /> 결과를 기다리는 중</div>
          </div>
        )}
      </section>
    </main>
  );
}
