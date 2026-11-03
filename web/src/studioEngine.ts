/**
 * Plays a Studio timeline through Web Audio.
 *
 * One <audio> element per sounding track (pitch-preserving time-stretch comes
 * from the browser), each into its own channel strip:
 *
 *   element → low shelf 200 Hz → peak 1 kHz → high shelf 3.5 kHz → fader → master → limiter → out
 *                                                         └→ echo send → delay ⟲ feedback → master
 *
 * The mix clock is the AudioContext clock, re-anchored to the first deck that
 * actually starts sounding after play or seek (so element start-up latency
 * doesn't become drift). Every frame each deck is told where it should be
 * (source time, rate, band gains) from the pure model; every 250 ms its
 * element's reported time is compared with that and nudged (±2 % rate) or,
 * when far out, re-seeked. Incoming decks start muted up to 0.75 s early so
 * they are corrected before they are heard.
 */
import {
  clipGainsAt, echoSendAt, gainToDb, mixTimeOf, rateAt, sourceAt, transitionAt,
  type StudioClip, type StudioTimeline,
} from "./studioModel";

export type EngineOptions = {
  /** Called every animation frame while playing, and after seeks. */
  onTime: (mixTime: number) => void;
  onPlayingChange: (playing: boolean) => void;
  /** A track's audio failed to load ("unavailable") or the browser refused to start it ("blocked"). */
  onIssue?: (trackId: number, kind: "unavailable" | "blocked") => void;
  audioUrl?: (trackId: number) => string;
};

type Deck = {
  clipIndex: number;
  trackId: number;
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  fader: GainNode;
  send: GainNode;
  running: boolean;
  failed: boolean;
  /** Context time of the next drift measurement. */
  nextCheck: number;
  /** Current correction: 0, +NUDGE or −NUDGE. */
  nudge: number;
  last: Record<"low" | "mid" | "high" | "fader" | "send" | "rate", number>;
  detach: () => void;
};

const MAX_DECKS = 3;
/** Load and seek a deck this long before it is heard. */
const ARM_AHEAD = 1.5;
/** Start its element this early, muted, so it is already in sync when it fades in. */
const PREROLL = 0.75;
const DRIFT_EVERY = 0.25;
const DRIFT_NUDGE = 0.04;
/** Once nudging, keep going until the deck is this close. */
const DRIFT_SETTLE = 0.012;
const DRIFT_SEEK = 0.15;
/** While a deck is inaudible a seek costs nothing, so correct small errors that way. */
const DRIFT_SEEK_MUTED = 0.025;
const MUTED = 0.05;
const NUDGE = 0.02;
/** After play() or a seek, let the element settle before measuring. */
const SETTLE_AFTER_START = 0.25;
const SEEK_LEAD = 0.03;
/** setTargetAtTime time constant for gains: fast enough for swaps, no clicks. */
const SMOOTH = 0.012;
const ECHO_FEEDBACK = 0.45;
const ECHO_WET = 0.6;
const ECHO_MAX_DELAY = 2;
const MASTER_GAIN = 0.85;

const EMPTY_TIMELINE: StudioTimeline = { clips: [], transitions: [], duration: 0 };
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export class StudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private echo: { input: GainNode; delay: DelayNode; feedback: GainNode; wet: GainNode; delayTime: number } | null = null;
  private echoMutedUntil = 0;
  private echoMuted = false;
  private decks = new Map<number, Deck>();
  private timeline: StudioTimeline = EMPTY_TIMELINE;
  private playing = false;
  private anchorMix = 0;
  private anchorCtx = 0;
  private pausedAt = 0;
  private loop: readonly [number, number] | null = null;
  private raf = 0;
  private interval: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private startToken = 0;
  /** After play or seek, the clock waits for the first audible deck to really start. */
  private awaitingStart = false;

  constructor(private readonly options: EngineOptions) {}

  get time(): number { return this.now(); }
  get isPlaying(): boolean { return this.playing; }

  setTimeline(timeline: StudioTimeline) {
    this.timeline = timeline;
    for (const [index, deck] of this.decks) {
      if (timeline.clips[index]?.trackId !== deck.trackId) this.release(index);
    }
    if (!this.playing) this.pausedAt = clamp(this.pausedAt, 0, timeline.duration);
    else this.reconcile(this.now());
  }

  async play(from?: number) {
    if (this.disposed || !this.timeline.clips.length) return;
    const token = ++this.startToken;
    const ctx = this.ensureContext();
    let t = clamp(from ?? this.pausedAt, 0, this.timeline.duration);
    if (t >= this.timeline.duration - 0.05) t = this.loop ? this.loop[0] : 0;
    this.pausedAt = t;
    try { await ctx.resume(); } catch { /* The context may still start on the next gesture. */ }
    if (token !== this.startToken || this.disposed) return;
    this.anchorMix = t;
    this.anchorCtx = ctx.currentTime;
    this.playing = true;
    this.awaitingStart = true;
    for (const deck of this.decks.values()) deck.running = false;
    this.startLoops();
    this.options.onPlayingChange(true);
    this.reconcile(t);
  }

  pause() {
    this.startToken++;
    if (!this.playing) return;
    this.pausedAt = this.now();
    this.playing = false;
    for (const deck of this.decks.values()) this.stopDeck(deck);
    this.silenceEcho();
    this.stopLoops();
    this.options.onPlayingChange(false);
    this.options.onTime(this.pausedAt);
  }

  seek(mixTime: number) {
    const t = clamp(mixTime, 0, this.timeline.duration);
    if (this.playing && this.ctx) {
      this.anchorMix = t;
      this.anchorCtx = this.ctx.currentTime;
      this.awaitingStart = true;
      for (const deck of this.decks.values()) this.stopDeck(deck);
      this.silenceEcho();
      this.reconcile(t);
    } else {
      this.pausedAt = t;
      if (this.ctx) this.reconcile(t);
    }
    this.options.onTime(t);
  }

  /** Loop a range of mix time while playing; null to stop looping. */
  setLoop(range: readonly [number, number] | null) {
    this.loop = range && range[1] > range[0] ? range : null;
  }

  dispose() {
    this.disposed = true;
    this.playing = false;
    this.stopLoops();
    for (const index of [...this.decks.keys()]) this.release(index);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  // ---- clock ----

  private now(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    return this.anchorMix + (this.ctx.currentTime - this.anchorCtx);
  }

  private startLoops() {
    if (!this.raf) {
      const frame = () => {
        this.raf = requestAnimationFrame(frame);
        this.tick(true);
      };
      this.raf = requestAnimationFrame(frame);
    }
    // rAF stops in background tabs; keep decks starting on time there too.
    this.interval ??= setInterval(() => this.tick(false), 100);
  }

  private stopLoops() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearInterval(this.interval);
    this.interval = undefined;
  }

  private tick(frame: boolean) {
    if (!this.playing) return;
    const t = this.now();
    if (this.loop && t >= this.loop[1]) { this.seek(this.loop[0]); return; }
    if (t >= this.timeline.duration) {
      this.pause();
      this.pausedAt = this.timeline.duration;
      this.options.onTime(this.pausedAt);
      return;
    }
    this.reconcile(t);
    if (frame) this.options.onTime(t);
  }

  // ---- decks ----

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(limiter).connect(ctx.destination);

    const input = ctx.createGain();
    const delay = ctx.createDelay(ECHO_MAX_DELAY);
    const feedback = ctx.createGain();
    const wet = ctx.createGain();
    delay.delayTime.value = 0.35;
    feedback.gain.value = ECHO_FEEDBACK;
    wet.gain.value = ECHO_WET;
    input.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(master);

    this.ctx = ctx;
    this.master = master;
    this.echo = { input, delay, feedback, wet, delayTime: 0.35 };
    return ctx;
  }

  /** Which clips need a deck at mix time t: sounding now, or about to. */
  private wanted(t: number): number[] {
    return this.timeline.clips
      .filter((clip) => clip.end > t && clip.start - ARM_AHEAD <= t)
      .sort((a, b) => a.start - b.start)
      .slice(0, MAX_DECKS)
      .map((clip) => clip.index);
  }

  private reconcile(t: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const wanted = this.wanted(t);
    for (const index of [...this.decks.keys()]) if (!wanted.includes(index)) this.release(index);
    for (const index of wanted) if (!this.decks.has(index)) this.createDeck(this.timeline.clips[index]!, t);
    if (!this.playing) return;
    const now = ctx.currentTime;
    for (const deck of this.decks.values()) {
      const clip = this.timeline.clips[deck.clipIndex];
      if (clip) this.drive(deck, clip, t, now);
    }
    this.driveEcho(t, now);
  }

  private createDeck(clip: StudioClip, t: number) {
    const ctx = this.ctx!;
    const el = new Audio();
    el.preload = "auto";
    el.preservesPitch = true;
    el.src = this.options.audioUrl?.(clip.trackId) ?? `/api/audio/${clip.trackId}`;
    const armAt = Math.max(0, sourceAt(clip, Math.max(t, clip.start)));
    el.currentTime = armAt;

    const source = ctx.createMediaElementSource(el);
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf"; low.frequency.value = 200; low.gain.value = 0;
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.8; mid.gain.value = 0;
    const high = ctx.createBiquadFilter();
    high.type = "highshelf"; high.frequency.value = 3500; high.gain.value = 0;
    const fader = ctx.createGain();
    fader.gain.value = 0;
    const send = ctx.createGain();
    send.gain.value = 0;
    source.connect(low).connect(mid).connect(high).connect(fader).connect(this.master!);
    high.connect(send).connect(this.echo!.input);

    const deck: Deck = {
      clipIndex: clip.index, trackId: clip.trackId, el, source, low, mid, high, fader, send,
      running: false, failed: false, nextCheck: 0, nudge: 0,
      last: { low: 0, mid: 0, high: 0, fader: 0, send: 0, rate: 1 },
      detach: () => {},
    };
    const onMeta = () => { if (!deck.running) el.currentTime = armAt; };
    const onPlaying = () => this.deckStarted(deck);
    const onError = () => {
      if (deck.failed) return;
      deck.failed = true;
      this.options.onIssue?.(clip.trackId, "unavailable");
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("error", onError);
    deck.detach = () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("error", onError);
    };
    this.decks.set(clip.index, deck);
  }

  /**
   * The first audible deck to start after play or seek sets the clock: mix
   * time resumes from where that element really is, now. Start-up latency
   * then never shows up as drift.
   */
  private deckStarted(deck: Deck) {
    const ctx = this.ctx;
    if (!ctx || !this.playing || !this.awaitingStart) return;
    const clip = this.timeline.clips[deck.clipIndex];
    if (!clip || clip.trackId !== deck.trackId) return;
    const t = this.now();
    if (t < clip.start || t >= clip.end) return;
    const mix = mixTimeOf(clip, deck.el.currentTime);
    if (!Number.isFinite(mix) || Math.abs(mix - t) > 1) return;
    this.anchorMix = mix;
    this.anchorCtx = ctx.currentTime;
    this.awaitingStart = false;
    deck.nextCheck = ctx.currentTime + DRIFT_EVERY;
  }

  private release(index: number) {
    const deck = this.decks.get(index);
    if (!deck) return;
    this.decks.delete(index);
    deck.detach();
    deck.el.pause();
    deck.el.removeAttribute("src");
    deck.el.load();
    for (const node of [deck.source, deck.low, deck.mid, deck.high, deck.fader, deck.send]) node.disconnect();
  }

  private stopDeck(deck: Deck) {
    deck.el.pause();
    deck.running = false;
    deck.nudge = 0;
  }

  private drive(deck: Deck, clip: StudioClip, t: number, now: number) {
    if (deck.failed) return;
    const el = deck.el;
    const expected = sourceAt(clip, t);
    const before = t < clip.start - PREROLL || expected < 0;
    const after = t >= clip.end || expected >= clip.duration - 0.02;
    if (before || after) {
      // Also covers a clip that an edit moved away from the playhead while it played.
      if (deck.running) this.stopDeck(deck);
      this.setParam(deck, "fader", deck.fader.gain, 0, now);
      return;
    }

    const base = rateAt(clip, t);
    if (!deck.running) {
      el.currentTime = expected;
      el.playbackRate = base;
      deck.last.rate = base;
      deck.nudge = 0;
      deck.running = true;
      deck.nextCheck = now + SETTLE_AFTER_START;
      void el.play().catch((error: unknown) => {
        if ((error as Error).name === "AbortError") return;
        deck.failed = true;
        this.options.onIssue?.(clip.trackId, "blocked");
      });
    } else if (now >= deck.nextCheck && !el.seeking && el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      deck.nextCheck = now + DRIFT_EVERY;
      const drift = el.currentTime - expected;
      const audible = deck.last.fader > MUTED;
      if (Math.abs(drift) > (audible ? DRIFT_SEEK : DRIFT_SEEK_MUTED)) {
        el.currentTime = expected + SEEK_LEAD * base;
        deck.nudge = 0;
        deck.nextCheck = now + SETTLE_AFTER_START;
      } else if (Math.abs(drift) > DRIFT_NUDGE || (deck.nudge !== 0 && Math.abs(drift) > DRIFT_SETTLE)) {
        deck.nudge = drift > 0 ? -NUDGE : NUDGE;
      } else {
        deck.nudge = 0;
      }
    }

    const rate = base * (1 + deck.nudge);
    if (Math.abs(rate - deck.last.rate) > 1e-4) {
      el.playbackRate = rate;
      deck.last.rate = rate;
    }

    const gains = clipGainsAt(this.timeline, clip.index, t);
    this.setParam(deck, "fader", deck.fader.gain, gains.volume, now);
    this.setParam(deck, "low", deck.low.gain, gainToDb(gains.bass), now);
    this.setParam(deck, "mid", deck.mid.gain, gainToDb(gains.mid), now);
    this.setParam(deck, "high", deck.high.gain, gainToDb(gains.high), now);
    this.setParam(deck, "send", deck.send.gain, echoSendAt(this.timeline, clip.index, t), now);
  }

  private setParam(deck: Deck, key: keyof Deck["last"], param: AudioParam, value: number, now: number) {
    if (Math.abs(deck.last[key] - value) < 1e-3) return;
    deck.last[key] = value;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, SMOOTH);
  }

  // ---- echo ----

  private driveEcho(t: number, now: number) {
    const echo = this.echo;
    if (!echo) return;
    if (this.echoMuted && now >= this.echoMutedUntil) {
      this.echoMuted = false;
      echo.feedback.gain.setTargetAtTime(ECHO_FEEDBACK, now, 0.01);
      echo.wet.gain.setTargetAtTime(ECHO_WET, now, 0.01);
    }
    const active = transitionAt(this.timeline, t);
    if (!active || active.mix.fx !== "echo") return;
    // Three quarters of a beat at the outgoing track's tempo.
    const delay = clamp(0.75 * active.beat, 0.05, ECHO_MAX_DELAY);
    if (Math.abs(delay - echo.delayTime) > 1e-3) {
      echo.delayTime = delay;
      echo.delay.delayTime.setTargetAtTime(delay, now, 0.02);
    }
  }

  /** Drain the echo so a seek or pause never replays the old tail. */
  private silenceEcho() {
    const echo = this.echo, ctx = this.ctx;
    if (!echo || !ctx) return;
    const now = ctx.currentTime;
    echo.feedback.gain.cancelScheduledValues(now);
    echo.wet.gain.cancelScheduledValues(now);
    echo.feedback.gain.setTargetAtTime(0, now, 0.005);
    echo.wet.gain.setTargetAtTime(0, now, 0.005);
    this.echoMuted = true;
    // With no feedback the buffer holds one delay time of audio; let it drain.
    this.echoMutedUntil = now + echo.delayTime + 0.05;
  }
}
