import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";

const NAMESPACE = "com.brian.shadowdark-torches";
const META_KEY = `${NAMESPACE}/torch` as const;


type TorchState = {
  durationMs: number;
  startAt?: number;
  pausedAt?: number;
  offsetMs?: number;
};

type PlayerRow = { id: string; name: string; torch: TorchState; isSelf: boolean };

const DEFAULT: TorchState = { durationMs: 60 * 60 * 1000, offsetMs: 0 };

function now() { return Date.now(); }
function getElapsed(s: TorchState): number {
  const base = s.offsetMs ?? 0;
  if (s.startAt && !s.pausedAt) return base + (now() - s.startAt);
  return base;
}
function getRemaining(s: TorchState): number {
  return Math.max(0, (s.durationMs ?? DEFAULT.durationMs) - getElapsed(s));
}
function isRunning(s: TorchState) { return !!s.startAt && !s.pausedAt && getRemaining(s) > 0; }
function format(ms: number) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Runtime validator for metadata payload */
function isTorchState(value: unknown): value is TorchState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.durationMs === "number" &&
    (v.startAt === undefined || typeof v.startAt === "number") &&
    (v.pausedAt === undefined || typeof v.pausedAt === "number") &&
    (v.offsetMs === undefined || typeof v.offsetMs === "number")
  );
}

/** Safely extract our torch state from arbitrary metadata */
function getTorchFromMetadata(metadata: unknown): TorchState {
  if (typeof metadata === "object" && metadata !== null) {
    const rec = metadata as Record<string, unknown>;
    const raw = rec[META_KEY];
    if (isTorchState(raw)) return raw;
  }
  return DEFAULT;
}

async function readSelf(): Promise<{ id: string; name: string; torch: TorchState }> {
  const id = OBR.player.id;
  const name = await OBR.player.getName();
  const metadata = await OBR.player.getMetadata(); // typed by SDK, we treat as unknown-safe
  return { id, name, torch: getTorchFromMetadata(metadata) };
}

async function writeSelf(update: Partial<TorchState>) {
  const current = (await readSelf()).torch;
  const next: TorchState = { ...current, ...update };
  await OBR.player.setMetadata({ [META_KEY]: next });
}

export default function App() {
  const [, forceTick] = useState(0);
  const [rows, setRows] = useState<PlayerRow[]>([]);
  const [minutesInput, setMinutesInput] = useState<number>(60);
  const [secondsInput, setSecondsInput] = useState<number>(0);

  async function refresh() {
    const self = await readSelf();
    const others = await OBR.party.getPlayers();
    const merged: PlayerRow[] = [
      { id: self.id, name: self.name, torch: self.torch, isSelf: true },
      ...others.map((p) => ({
        id: p.id,
        name: p.name,
        torch: getTorchFromMetadata(p.metadata), // p.metadata may be undefined; helper handles it
        isSelf: false,
      })),
    ];
    setRows(merged);
  }

  useEffect(() => {
    if (!OBR.isAvailable) return;
    refresh();
    const offParty = OBR.party.onChange(refresh);
    const offPlayer = OBR.player.onChange(refresh);
    const t = setInterval(() => forceTick((x) => x + 1), 500);
    return () => { offParty(); offPlayer(); clearInterval(t); };
  }, []);

  const start = async () => {
    const self = await readSelf();
    if (getRemaining(self.torch) <= 0) {
      await writeSelf({ offsetMs: 0, pausedAt: undefined, startAt: now() });
    } else {
      await writeSelf({ startAt: now(), pausedAt: undefined });
    }
  };
  const pause = async () => {
    const self = await readSelf();
    await writeSelf({ pausedAt: now(), offsetMs: getElapsed(self.torch), startAt: undefined });
  };

const setDuration = async (mins: number, secs: number) => {
  const m = Math.max(0, Math.floor(mins));
  const s = Math.max(0, Math.min(59, Math.floor(secs))); // clamp 0–59
  const totalSeconds = Math.max(1, m * 60 + s);          // at least 1s
  await writeSelf({
    durationMs: totalSeconds * 1000,
    offsetMs: 0,
    pausedAt: undefined,
    startAt: Date.now(), // start immediately
  });
};


  return (
    <div className="p-3 text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ fontSize: 18, margin: 0, marginBottom: 8 }}>Shadowdark Torch Timers</h2>
      <Controls
  minutes={minutesInput}
  seconds={secondsInput}
  onMinutesChange={setMinutesInput}
  onSecondsChange={setSecondsInput}
  onStart={start}
  onPause={pause}
  onSetDuration={() => setDuration(minutesInput, secondsInput)}
/>

      <div style={{ marginTop: 10, borderTop: "1px solid #ddd", paddingTop: 8 }}>
        {rows.map((p) => {
  const rem = getRemaining(p.torch);
  const total = p.torch.durationMs ?? DEFAULT.durationMs;
  const pct = Math.max(0, Math.min(100, (rem / total) * 100));
  const running = isRunning(p.torch);
  const expired = rem <= 0;

  return (
    <div key={p.id}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 8,
        background: p.isSelf ? "rgba(0,0,0,0.03)" : "transparent",
        marginBottom: 6
      }}>
      <div style={{ fontWeight: 600 }}>{p.name}</div>
      <div title={running ? "burning" : expired ? "expired" : "paused"}
           style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
        {format(rem)} {expired ? "⛔" : running ? "🔥" : "⏸️"}
      </div>

      {/* Life gauge */}
<div style={{ gridColumn: "1 / -1" }}>
  <div
    style={{
      position: "relative",
      height: 12,
      width: "100%",
      background: "linear-gradient(90deg, #ffe9a3, #ffc163, #ff6a4a)", // full flame, always visible
      borderRadius: 8,
      overflow: "hidden",
      boxShadow: "inset 0 1px 2px rgba(0,0,0,0.25)"
    }}
  >
    {/* Darkness overlay grows as time depletes */}
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        bottom: 0,
        width: `${100 - pct}%`,     // 0% at start, 100% when expired
        background: "#000",         // pure black “darkness”
        transition: "width 300ms linear"
      }}
    />
  </div>
</div>

    </div>
  );
})}
      </div>
      <p style={{ opacity: 0.7, marginTop: 8 }}>
        Everyone sees updates instantly. Refreshing the page will reset your torch timer.</p>
    </div>
  );
}

function Controls(props: {
  minutes: number;
  seconds: number;
  onMinutesChange: (m: number) => void;
  onSecondsChange: (s: number) => void;
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onSetDuration: () => Promise<void>;
}) {
  const { minutes, seconds, onMinutesChange, onSecondsChange } = props;
  return (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {/* Row 1: buttons */}
    <div style={{ display: "flex", gap: 8 }}>
      <button onClick={props.onStart}>Start</button>
      <button onClick={props.onPause}>Pause</button>
      <button title="Set & Restart" onClick={props.onSetDuration}>Set</button>
    </div>

    {/* Row 2: duration controls */}
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span>Duration:</span>

      <input
        type="number"
        min={0}
        value={minutes}
        onChange={(e) =>
          onMinutesChange(Math.max(0, parseInt(e.target.value || "0", 10)))
        }
        style={{ width: 64 }}
        aria-label="Minutes"
      />
      <span>min</span>

      <input
        type="number"
        min={0}
        max={59}
        value={seconds}
        onChange={(e) =>
          onSecondsChange(
            Math.max(0, Math.min(59, parseInt(e.target.value || "0", 10)))
          )
        }
        style={{ width: 64 }}
        aria-label="Seconds"
      />
      <span>sec</span>
    </div>
  </div>
);

}
