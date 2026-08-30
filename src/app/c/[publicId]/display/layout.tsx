import type { ReactNode } from "react";

// Full-bleed layout for the stream / OBS Browser Source display page — overrides the
// centered 560px container from the root layout.
export default function DisplayLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b0b0f",
        color: "#fafafa",
        textAlign: "center",
        padding: "3vh 3vw",
      }}
    >
      {children}
    </div>
  );
}
