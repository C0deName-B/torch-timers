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

const setMinutes = async (mins: number) => {
  const ms = Math.max(1, mins) * 60 * 1000;
  await writeSelf({
    durationMs: ms,
    offsetMs: 0,
    pausedAt: undefined,
    startAt: now(), // start immediately using new duration
  });
};

  return (
    <div className="p-3 text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ fontSize: 18, margin: 0, marginBottom: 8 }}>Shadowdark Torch Timers</h2>
      <Controls onStart={start} onPause={pause} onReset={() => writeSelf(DEFAULT)} onSetMinutes={setMinutes} />
      <div style={{ marginTop: 10, borderTop: "1px solid #ddd", paddingTop: 8 }}>
        {rows.map((p) => {
          const rem = getRemaining(p.torch);
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
            </div>
          );
        })}
      </div>
      <p style={{ opacity: 0.7, marginTop: 8 }}>
        Everyone sees updates instantly thanks to player metadata.
      </p>
    </div>
  );
}

function Controls(props: {
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onReset: () => Promise<void>;
  onSetMinutes: (m: number) => Promise<void>;
}) {
  const [mins, setMins] = useState(60);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button onClick={props.onStart}>Start</button>
      <button onClick={props.onPause}>Pause</button>
      <button onClick={props.onReset}>Reset</button>
      <span style={{ marginLeft: 6 }}>Duration (min):</span>
      <input
        type="number"
        min={1}
        value={mins}
        onChange={(e) => setMins(parseInt(e.target.value || "1", 10))}
        style={{ width: 70 }}
      />
      <button onClick={() => props.onSetMinutes(mins)}>Set</button>
    </div>
  );
}
