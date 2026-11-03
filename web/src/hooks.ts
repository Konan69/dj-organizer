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
    // An error may be the only word on what went wrong, so it stays until dismissed.
    if (kind !== "err") timer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);
  return { toast, show, dismiss };
}

/** Audio element driven imperatively; React only mirrors its state. */
export function usePlayer() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const activeId = useRef<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
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
    const onMetadata = () => {
      if (pendingSeek.current === null || !Number.isFinite(a.duration)) return;
      a.currentTime = Math.min(pendingSeek.current, Math.max(0, a.duration - 0.01));
      pendingSeek.current = null;
      onTime();
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("durationchange", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("loadedmetadata", onMetadata);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("durationchange", onTime);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("loadedmetadata", onMetadata);
      a.pause();
    };
  }, []);

  const play = useCallback((id: number) => {
    const a = ref.current;
    if (!a) return;
    activeId.current = id;
    pendingSeek.current = null;
    a.src = `/api/audio/${id}`;
    setTime(0); setDuration(0);
    void a.play().catch(() => {});
    setPlayingId(id);
  }, []);

  const playAt = useCallback((id: number, seconds: number) => {
    const a = ref.current;
    if (!a || !Number.isFinite(seconds)) return;
    const target = Math.max(0, seconds);
    if (activeId.current === id && a.readyState >= 1 && Number.isFinite(a.duration)) {
      pendingSeek.current = null;
      a.currentTime = Math.min(target, Math.max(0, a.duration - 0.01));
      setTime(a.currentTime);
    } else {
      pendingSeek.current = target;
      if (activeId.current !== id) {
        activeId.current = id;
        a.src = `/api/audio/${id}`;
        setTime(0); setDuration(0);
      }
    }
    setPlayingId(id);
    void a.play().catch(() => {});
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

  return { playingId, paused, time, duration, play, playAt, toggle, seek, setVolume, onEnded };
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
