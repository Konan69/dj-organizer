import { useEffect, useRef, useState } from "react";

/* The AV visualizer (http://localhost:5177) follows this player: it loads the same track,
   plays no sound of its own, and rides the time we report. */
const AV = "http://localhost:5177";
const KEY = "av-visualize";

type Now = { id: number; title?: string | null; filename?: string; artist?: string | null } | undefined;
type PlayerLike = { playingId: number | null; paused: boolean; time: number; duration: number };

export function VisualizeButton({ player, now }: { player: PlayerLike; now: Now }) {
  const [on, setOn] = useState(() => localStorage.getItem(KEY) === "on");
  const last = useRef(0);

  const report = () => {
    if (!now) return;
    last.current = performance.now();
    // text/plain keeps this a simple request (no preflight); the AV server parses the JSON.
    void fetch(`${AV}/api/dj/now-playing`, {
      method: "POST", headers: { "Content-Type": "text/plain" }, keepalive: true,
      body: JSON.stringify({
        id: now.id, title: now.title ?? now.filename ?? `Track ${now.id}`, artist: now.artist ?? null,
        time: player.time, duration: player.duration, playing: !player.paused, sentAt: Date.now(),
      }),
    }).catch(() => {});
  };

  // Track changes, play and pause go out at once; while playing, a heartbeat every half second.
  useEffect(() => { if (on) report(); }, [on, now?.id, player.paused]);
  useEffect(() => { if (on && performance.now() - last.current >= 500) report(); }, [player.time]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    localStorage.setItem(KEY, next ? "on" : "off");
    if (next) window.open(`${AV}/visualizer.html?follow=1`, "av-visualizer");
  };

  return (
    <button className={`ui-icon-btn ${on ? "on" : ""}`} onClick={toggle} aria-pressed={on} aria-label="Visualize" title="Visualize">
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="1.8" />
        <ellipse cx="12" cy="12" rx="9" ry="3.4" />
        <ellipse cx="12" cy="12" rx="9" ry="3.4" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="3.4" transform="rotate(120 12 12)" />
      </svg>
    </button>
  );
}
