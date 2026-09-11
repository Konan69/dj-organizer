import { useCallback, useEffect, useRef, useState } from "react";

export const fmtTime = (s: number | null | undefined) =>
  s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "—";

export const fmtMb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

export type ToastKind = "" | "ok" | "err";

export function useToast() {
  const [toast, setToast] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((msg: string, kind: ToastKind = "") => {
    setToast({ msg, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);
  return { toast, show };
}

/** Audio element driven imperatively; React only mirrors its state. */
export function usePlayer() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  if (!ref.current && typeof Audio !== "undefined") {
    ref.current = new Audio();
    ref.current.volume = 0.8;
  }

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onTime = () => { setTime(a.currentTime); setDuration(a.duration || 0); };
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("durationchange", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("durationchange", onTime);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, []);

  const play = useCallback((id: number) => {
    const a = ref.current;
    if (!a) return;
    a.src = `/api/audio/${id}`;
    void a.play().catch(() => {});
    setPlayingId(id);
  }, []);

  const toggle = useCallback(() => {
    const a = ref.current;
    if (!a?.src) return;
    if (a.paused) void a.play().catch(() => {}); else a.pause();
  }, []);

  const seek = useCallback((ratio: number) => {
    const a = ref.current;
    if (a?.duration) a.currentTime = ratio * a.duration;
  }, []);

  const setVolume = useCallback((v: number) => {
    if (ref.current) ref.current.volume = v;
  }, []);

  const onEnded = useCallback((cb: () => void) => {
    const a = ref.current;
    if (!a) return;
    a.onended = cb;
  }, []);

  return { playingId, paused, time, duration, play, toggle, seek, setVolume, onEnded };
}

/** Row selection with click / ctrl-click / shift-range over an ordered list. */
export function useSelection<T extends { id: number }>(ordered: T[]) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);

  const click = useCallback((id: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && anchor.current != null) {
        const a = ordered.findIndex((t) => t.id === anchor.current);
        const b = ordered.findIndex((t) => t.id === id);
        if (a > -1 && b > -1) {
          next.clear();
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ordered[i]!.id);
          return next;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        if (next.has(id)) next.delete(id); else next.add(id);
      } else if (!next.has(id)) {
        next.clear();
        next.add(id);
      }
      anchor.current = id;
      return next;
    });
  }, [ordered]);

  const selectAll = useCallback(() => setSel(new Set(ordered.map((t) => t.id))), [ordered]);
  const clear = useCallback(() => setSel(new Set()), []);
  const replace = useCallback((id: number) => { setSel(new Set([id])); anchor.current = id; }, []);

  return { sel, click, selectAll, clear, replace, setSel };
}
