// Alarm audio: announces each active, unacknowledged alarm as
// [alert tone] then [spoken clarification], repeating until it is acknowledged or clears.
//
// Sounds come from audio/manifest.json (numbered files 14-18). Anything missing falls
// back to a synthesized beep (tones) or the browser's speech synthesis (speech), so
// alarms are never silent just because a file was not deployed.

const DEFAULT_MANIFEST = {
  files: {},
  tones: { warning: null, critical: null },
  speech: {},
  repeat: { criticalSec: 10, warningSec: 30, speechOnRepeat: true },
  tts: { enabled: true, lang: "ar" },
};

// Fallback beep patterns: [frequencyHz, durationMs, gapMs]
const SYNTH_PATTERNS = {
  warning: [[880, 180, 120], [880, 180, 0]],
  critical: [[1320, 120, 60], [990, 120, 60], [1320, 120, 60], [990, 120, 0]],
};
const TICK_MS = 500;
const TTS_MAX_MS = 8000;

export class AlarmAudio extends EventTarget {
  constructor({ baseUrl = "audio/" } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.manifest = structuredClone(DEFAULT_MANIFEST);
    this.ctx = null;
    this.buffers = new Map(); // sound id -> AudioBuffer
    this.fileStatus = new Map(); // sound id -> { state: "loaded" | "missing", src?, channels?, durationSec? }
    this.muted = false;
    this.schedule = new Map(); // alarm key -> { alarm, nextAt, plays }
    this.playing = false;
    this.timer = null;
  }

  get unlocked() {
    return this.ctx !== null && this.ctx.state === "running";
  }

  async loadManifest() {
    try {
      const res = await fetch(`${this.baseUrl}manifest.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = await res.json();
      this.manifest = {
        ...DEFAULT_MANIFEST,
        ...m,
        tones: { ...DEFAULT_MANIFEST.tones, ...m.tones },
        repeat: { ...DEFAULT_MANIFEST.repeat, ...m.repeat },
        tts: { ...DEFAULT_MANIFEST.tts, ...m.tts },
      };
    } catch (err) {
      console.warn("Alarm audio manifest not loaded, using synthesized sounds only:", err);
    }
    this.emitStatus();
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      await this.decodeAll();
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emitStatus();
    this.tick();
  }

  setMuted(muted) {
    this.muted = muted;
    this.emitStatus();
    if (!muted) this.tick();
  }

  /** Feed the server's active alarm list; call on every change. */
  update(alarms) {
    const live = new Set();
    for (const alarm of alarms) {
      if (alarm.acknowledged) continue;
      // raisedAt distinguishes a re-raised alarm, which should be announced afresh.
      const key = `${alarm.id}@${alarm.raisedAt}`;
      live.add(key);
      const entry = this.schedule.get(key);
      if (entry) entry.alarm = alarm;
      else this.schedule.set(key, { alarm, nextAt: 0, plays: 0 });
    }
    for (const key of this.schedule.keys()) {
      if (!live.has(key)) this.schedule.delete(key);
    }
    this.tick();
  }

  status() {
    return {
      unlocked: this.unlocked,
      muted: this.muted,
      files: Object.entries(this.manifest.files).map(([id, f]) => ({
        id,
        kind: f.kind,
        description: f.description ?? "",
        ...(this.fileStatus.get(id) ?? { state: this.ctx ? "missing" : "not loaded" }),
      })),
    };
  }

  /** Plays one sound file by manifest id (used by the sound board to identify files). */
  async preview(id) {
    if (!this.ctx) await this.unlock();
    return this.playBuffer(id);
  }

  /** Plays a full announcement for the given severity so the operator can check volume. */
  async test(severity = "warning") {
    if (!this.ctx) await this.unlock();
    await this.announce(
      { id: "TEST", severity, title: { en: "Audio test", ar: "اختبار الصوت" } },
      true
    );
  }

  // --- internals -------------------------------------------------------------

  tick() {
    if (this.playing || this.muted || !this.unlocked) return;
    const now = Date.now();
    const due = [...this.schedule.entries()]
      .filter(([, e]) => e.nextAt <= now)
      .sort(([, a], [, b]) => rank(b.alarm) - rank(a.alarm) || a.nextAt - b.nextAt);
    if (due.length === 0) return;
    const [key, entry] = due[0];
    this.playing = true;
    this.announce(entry.alarm, entry.plays === 0)
      .catch((err) => console.warn("Alarm announcement failed:", err))
      .finally(() => {
        this.playing = false;
        // The alarm may have been acknowledged while it was playing.
        if (this.schedule.get(key) === entry) {
          entry.plays += 1;
          const { criticalSec, warningSec } = this.manifest.repeat;
          entry.nextAt = Date.now() + 1000 * (entry.alarm.severity === "critical" ? criticalSec : warningSec);
        }
        this.tick();
      });
  }

  async announce(alarm, first) {
    const toneId = this.manifest.tones[alarm.severity];
    if (!(await this.playBuffer(toneId))) await this.synthBeep(alarm.severity);

    if (!first && !this.manifest.repeat.speechOnRepeat) return;
    const speechId = this.manifest.speech[alarm.id];
    if (await this.playBuffer(speechId)) return;
    if (this.manifest.tts.enabled) await this.speak(alarm);
  }

  async decodeAll() {
    const entries = Object.entries(this.manifest.files);
    await Promise.all(
      entries.map(async ([id, file]) => {
        const sources = Array.isArray(file.src) ? file.src : [file.src];
        for (const src of sources) {
          try {
            const res = await fetch(`${this.baseUrl}${src}`);
            if (!res.ok) continue;
            const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
            this.buffers.set(id, buffer);
            this.fileStatus.set(id, {
              state: "loaded",
              src,
              channels: buffer.numberOfChannels,
              durationSec: buffer.duration,
            });
            return;
          } catch (err) {
            console.warn(`Cannot decode ${src}:`, err);
          }
        }
        this.fileStatus.set(id, { state: "missing" });
      })
    );
  }

  playBuffer(id) {
    const buffer = id != null ? this.buffers.get(String(id)) : undefined;
    if (!buffer || !this.ctx) return Promise.resolve(false);
    return new Promise((resolve) => {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);
      source.onended = () => resolve(true);
      source.start();
    });
  }

  async synthBeep(severity) {
    if (!this.ctx) return;
    const pattern = SYNTH_PATTERNS[severity] ?? SYNTH_PATTERNS.warning;
    let t = this.ctx.currentTime + 0.02;
    for (const [freq, durMs, gapMs] of pattern) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + durMs / 1000);
      t += (durMs + gapMs) / 1000;
    }
    await sleep((t - this.ctx.currentTime) * 1000);
  }

  speak(alarm) {
    if (!("speechSynthesis" in window)) return Promise.resolve();
    const wanted = this.manifest.tts.lang;
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.toLowerCase().startsWith(wanted.toLowerCase()));
    // Without a voice for the configured language, speak the English title instead.
    const useWanted = Boolean(voice) || wanted.startsWith("en");
    const text = (useWanted ? alarm.title[wanted.slice(0, 2)] : null) ?? alarm.title.en;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = useWanted ? wanted : "en";
    if (voice) utterance.voice = voice;
    return new Promise((resolve) => {
      // onend is not reliable in every browser; never let it block the queue.
      const guard = setTimeout(resolve, TTS_MAX_MS);
      utterance.onend = utterance.onerror = () => {
        clearTimeout(guard);
        resolve();
      };
      speechSynthesis.speak(utterance);
    });
  }

  emitStatus() {
    this.dispatchEvent(new CustomEvent("status", { detail: this.status() }));
  }
}

function rank(alarm) {
  return alarm.severity === "critical" ? 1 : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
