import { useEffect, useRef, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import type { Item } from "@owlbear-rodeo/sdk";


const NAMESPACE = "com.brian.shadowdark-torches";
const META_KEY = `${NAMESPACE}/torch` as const;
const ALERT_CHANNEL = `${NAMESPACE}/alerts`;

// === Types ===
export type TorchState = {
  id?: string; // stable id for deletes & event tracking
  name?: string; // display name
  durationMs: number;
  startAt?: number;
  pausedAt?: number;
  offsetMs?: number;
};

// Room-wide shared timer (not keyed by player id)
type RoomTimer = TorchState & {
  id: string; // required at storage time
  ownerId?: string; // may be ephemeral; used when available
  ownerName: string; // display label; persists if owner disconnects/changes id
  lightId: string; // unique id for this light source, used for event tracking
};

export type PlayerRow = { id: string; name: string; torches: TorchState[]; isSelf: boolean };

const DEFAULT: TorchState = { durationMs: 60 * 60 * 1000, offsetMs: 0 };

// === Time utilities ===
function now() { return Date.now(); }
function newId() {
  const g = globalThis as typeof globalThis;
  return g?.crypto?.randomUUID ? g.crypto.randomUUID() : `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getElapsed(s: TorchState): number {
  const base = s.offsetMs ?? 0;
  if (s.startAt && !s.pausedAt) return base + (now() - s.startAt);
  return base;
}
function getRemaining(s: TorchState): number { return Math.max(0, (s.durationMs ?? DEFAULT.durationMs) - getElapsed(s)); }
function isRunning(s: TorchState) { return !!s.startAt && !s.pausedAt && getRemaining(s) > 0; }
function format(ms: number) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}



function isRoomTimer(value: unknown): value is RoomTimer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.ownerName === "string" &&
    typeof v.durationMs === "number" &&
    (v.startAt === undefined || typeof v.startAt === "number") &&
    (v.pausedAt === undefined || typeof v.pausedAt === "number") &&
    (v.offsetMs === undefined || typeof v.offsetMs === "number") &&
    (v.ownerId === undefined || typeof v.ownerId === "string") &&
    (v.name === undefined || typeof v.name === "string") &&
    (v.lightId === undefined || typeof v.lightId === "string")
  );
}


function isRoomTimerArray(value: unknown): value is RoomTimer[] { return Array.isArray(value) && value.every(isRoomTimer); }

// === Metadata helpers (room-scoped) ===
async function readRoomTimers(): Promise<RoomTimer[]> {
  const metadata = await OBR.room.getMetadata();
  const raw = (metadata as Record<string, unknown>)[META_KEY];

  if (isRoomTimerArray(raw)) return raw.map((t) => ({ ...t, id: t.id || newId() }));

  return [];
}

async function writeRoomTimers(updater: (prev: RoomTimer[]) => RoomTimer[]): Promise<void> {
  const prev = await readRoomTimers();
  const next = updater(prev).map((t) => ({ ...t, id: t.id || newId(), ownerName: t.ownerName || "Player" }));
  await OBR.room.setMetadata({ [META_KEY]: next });
}

function getClosestRemainingMs(players: PlayerRow[]): number | undefined {
  let best: number | undefined;
  for (const p of players) {
    for (const t of p.torches) {
      if (!isRunning(t)) continue;
      const r = getRemaining(t);
      if (r > 0 && (best === undefined || r < best)) best = r;
    }
  }
  return best;
}

function formatBadge(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function App() {
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState<PlayerRow[]>([]);
  const [minutesInput, setMinutesInput] = useState<number>(60);
  const [secondsInput, setSecondsInput] = useState<number>(0);
  const [nameInput, setNameInput] = useState<string>("");
  const [isOpen, setIsOpen] = useState<boolean>(true);
  const prevRemainingRef = useRef<Record<string, number>>({});
  const handledEventIdsRef = useRef<Set<string>>(new Set());
  const lastBadgeRef = useRef<string | undefined>(undefined);
  
  const inputsRef = useRef({ m: minutesInput, s: secondsInput, name: nameInput });
  useEffect(() => {
  inputsRef.current = { m: minutesInput, s: secondsInput, name: nameInput };
}, [minutesInput, secondsInput, nameInput]);


  async function refresh() {
    const selfId = OBR.player.id;
    const selfName = await OBR.player.getName();
    const party = await OBR.party.getPlayers();
    const timers = await readRoomTimers();

    // Build a lookup for live party names by id
    const nameById = new Map<string, string>();
    party.forEach((p) => nameById.set(p.id, p.name));

    // Group timers by owner. Use current party name if available; else use stored ownerName.
    const rowsMap = new Map<string, PlayerRow>();
    for (const t of timers) {
      const ownerKey = t.ownerId ?? `name:${t.ownerName}`;
      const displayName = t.ownerId ? (nameById.get(t.ownerId) ?? t.ownerName) : t.ownerName;
      let row = rowsMap.get(ownerKey);
      if (!row) {
        row = { id: ownerKey, name: displayName, torches: [], isSelf: true /* allow delete on all */ };
        rowsMap.set(ownerKey, row);
      } else if (row.name !== displayName) {
        row.name = displayName;
      }
      row.torches.push(t);
    }

    // Ensure current player row exists even if they have no timers yet (optional)
    if (!rowsMap.size) {
      rowsMap.set(selfId, { id: selfId, name: selfName, torches: [], isSelf: true });
    }

    setRows(Array.from(rowsMap.values()));
  }

  // === Effects ===
  useEffect(() => {
    if (!OBR.isAvailable) return;
    refresh();

    const offParty = OBR.party.onChange(refresh);
    const offRoom = OBR.room.onMetadataChange(() => refresh());
    const offOpen = OBR.action.onOpenChange(setIsOpen);

    // 🔔 Receive alerts from others and toast locally
    const offBroadcast = OBR.broadcast.onMessage(ALERT_CHANNEL, async (evt) => {
      const data = evt.data as { id: string; name: string; playerId: string; timerName?: string } | undefined;
      if (!data || handledEventIdsRef.current.has(data.id)) return;
      handledEventIdsRef.current.add(data.id);
      const label = data.timerName ? `${data.name}'s "${data.timerName}"` : `${data.name}'s light source`;
      await OBR.notification.show(`💡 ${label} has diminished!`, "WARNING");
    });

    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => { offParty(); offRoom(); offOpen(); offBroadcast(); clearInterval(t); };
  }, []);

  useEffect(() => {
  if (!OBR.isAvailable) return;

  const seen = new Set<string>();

  // Seed with current local items so we only react to *new* lights
  (async () => {
    try {
      const local = await OBR.scene.local.getItems();
      local.forEach((it: Item) => seen.add(it.id));
    } catch {/*itnore errors*/}
  })();

  // React to new local LIGHT items
  const offLocal = OBR.scene.local.onChange(async (items) => {
    const lights = items.filter((it: Item) => it.type === "LIGHT");
    for (const light of lights) {
      if (seen.has(light.id)) continue;
      seen.add(light.id);

      // snapshot current inputs
      const { m, s, name } = inputsRef.current;
      const totalSeconds = Math.max(1, Math.floor(m) * 60 + Math.min(59, Math.max(0, Math.floor(s))));
      const ownerId = OBR.player.id;
      const ownerName = await OBR.player.getName();

      await writeRoomTimers((prev) => [
        ...prev,
        {
          id: newId(),
          name: (name ?? "").trim() || "Light",
          durationMs: totalSeconds * 1000,
          offsetMs: 0,
          pausedAt: undefined,
          startAt: Date.now(),
          ownerId,
          ownerName,
          lightId: light.id, // ← link timer to the light
        },
      ]);
    }
  });

  return () => offLocal();
}, []);

  useEffect(() => {
    if (!OBR.isAvailable) return;
    async function updateBadge() {
      if (isOpen) {
        if (lastBadgeRef.current !== undefined) {
          await OBR.action.setBadgeText(undefined);
          lastBadgeRef.current = undefined;
        }
        return;
      }
      const closest = getClosestRemainingMs(rows);
      const next = closest === undefined ? undefined : formatBadge(closest);
      if (next !== lastBadgeRef.current) {
        if (next === undefined) {
          await OBR.action.setBadgeText(undefined);
        } else {
          await OBR.action.setBadgeBackgroundColor("rgba(240, 197, 116, 1)");
          await OBR.action.setBadgeText(next);
        }
        lastBadgeRef.current = next;
      }
    }
    updateBadge();
  }, [rows, isOpen, tick]);

  // Cross-zero detector → notifications & broadcast
  useEffect(() => {
    if (!OBR.isAvailable) return;

    const prev = prevRemainingRef.current;

    for (const p of rows) {
      p.torches.forEach((torch, idx) => {
        const rem = getRemaining(torch);
        const key = `${p.id}:${torch.id ?? idx}`;
        const prevRem = prev[key] ?? rem;

        const crossedToZero = prevRem > 0 && rem <= 0;
        const wasActive = !!torch.startAt && !torch.pausedAt;

        if (crossedToZero && wasActive) {
          const eventId = `${p.id}:${torch.id ?? idx}:${torch.durationMs}:${torch.startAt ?? 0}:${torch.offsetMs ?? 0}`;
          if (!handledEventIdsRef.current.has(eventId)) {
            handledEventIdsRef.current.add(eventId);
            const label = torch.name ? `${p.name}'s "${torch.name}"` : `${p.name}'s light source`;
            OBR.notification.show(`💡 ${label} has diminished!`, "WARNING");
            OBR.broadcast.sendMessage(
              ALERT_CHANNEL,
              { id: eventId, name: p.name, playerId: p.id, timerName: torch.name },
              { destination: "REMOTE" }
            );

            (async () => {
              if (isRoomTimer(torch)) {
                const lightId = torch.lightId; // OK
                // delete local light if owner
                if (lightId && p.id === OBR.player.id) {
                  try {
                    await OBR.scene.local.deleteItems([lightId]);
                  } catch {
                    /* noop */
                  }
                }

                // remove the expired timer
                await writeRoomTimers(prev => prev.filter(t => t.id !== torch.id));
              }
            })();

          }
        }

        prev[key] = rem;
      });
    }
  }, [rows, tick]);

  // === Controls (room-shared over flat array) ===
  const start = async () => {
    const startedAt = now();
    await writeRoomTimers((prev) => prev.map((t) => {
      if(isRunning(t)) return t; 
      if (getRemaining(t) <= 0) return { ...t, offsetMs: 0, pausedAt: undefined, startAt: startedAt };
      return { ...t, startAt: startedAt, pausedAt: undefined };
    }));
  };

  const pause = async () => {
    const at = now();
    await writeRoomTimers((prev) => prev.map((t) => ({ ...t, pausedAt: at, offsetMs: getElapsed(t), startAt: undefined })));
  };

  const setDuration = async (mins: number, secs: number, name?: string) => {
    const m = Math.max(0, Math.floor(mins));
    const s = Math.max(0, Math.min(59, Math.floor(secs)));
    const totalSeconds = Math.max(1, m * 60 + s);
    const ownerId = OBR.player.id;
    const ownerName = await OBR.player.getName();

    await writeRoomTimers((prev) => [
      ...prev,
      {
        id: newId(),
        name: (name ?? "").trim() || undefined,
        durationMs: totalSeconds * 1000,
        offsetMs: 0,
        pausedAt: undefined,
        startAt: now(),
        ownerId,
        ownerName,
        lightId: ""
      },
    ]);

    setNameInput("");
  };

  const deleteTorch = async (torchId: string) => {
    await writeRoomTimers((prev) => prev.filter((t) => t.id !== torchId));
  };

  // === UI (unchanged) ===
  return (
    <div
      className="p-3 text-sm"
      style={{
        fontFamily: "system-ui, sans-serif",
        color: "white", // keep text white
      }}
    >
      <h2 style={{ fontSize: 18, margin: 0, marginBottom: 8 }}>Shadowdark Torch Timers</h2>
      <Controls
        minutes={minutesInput}
        seconds={secondsInput}
        name={nameInput}
        onMinutesChange={setMinutesInput}
        onSecondsChange={setSecondsInput}
        onNameChange={setNameInput}
        onStart={start}
        onPause={pause}
        onSetDuration={() => setDuration(minutesInput, secondsInput, nameInput)}
      />

      <div style={{ marginTop: 10, borderTop: "1px solid #ddd", paddingTop: 8 }}>
        {rows.map((p) => (
          <div key={p.id} style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.name}</div>

            {p.torches.map((t, idx) => {
              const rem = getRemaining(t);
              const total = t.durationMs ?? DEFAULT.durationMs;
              const pct = Math.max(0, Math.min(100, (rem / total) * 100));
              const running = isRunning(t);
              const expired = rem <= 0;

              return (
                <div
                  key={`${p.id}:${t.id ?? idx}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 8,
                    background: p.isSelf ? "rgba(0,0,0,0.03)" : "transparent",
                    marginBottom: 6,
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      opacity: 0.8,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 140,
                    }}
                  >
                    {t.name ? t.name : `#${idx + 1}`}
                  </div>
                  <div
                    title={running ? "burning" : expired ? "expired" : "paused"}
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 700,
                      textAlign: "right",
                    }}
                  >
                    {format(rem)} {expired ? "⛔" : running ? "🔥" : "⏸️"}
                  </div>

                  {/* Delete (self only) */}
                  <div>
                    {p.isSelf && (
                      <button
                        title="Delete timer"
                        onClick={() => deleteTorch(t.id ?? String(idx))}
                        style={{ cursor: "pointer" }}
                      >
                        🗑️
                      </button>
                    )}
                  </div>

                  {/* Life gauge */}
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div
                      style={{
                        position: "relative",
                        height: 12,
                        width: "100%",
                        background: "linear-gradient(90deg, #ffe9a3, #ffc163, #ff6a4a)",
                        borderRadius: 8,
                        overflow: "hidden",
                        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.25)",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          bottom: 0,
                          width: `${100 - pct}%`,
                          background: "#000",
                          transition: "width 300ms linear",
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <p style={{ opacity: 0.7, marginTop: 8 }}>
        Everyone is alerted when a light source diminishes. 
        v1.0.17
      </p>
    </div>
  );
}

function Controls(props: {
  minutes: number;
  seconds: number;
  name: string;
  onMinutesChange: (m: number) => void;
  onSecondsChange: (s: number) => void;
  onNameChange: (n: string) => void;
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onSetDuration: () => Promise<void>;
}) {
  const { minutes, seconds, name, onMinutesChange, onSecondsChange, onNameChange } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Row 1: buttons */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={props.onStart}>Start</button>
        <button onClick={props.onPause}>Pause</button>
        <button title="Add & Start new timer with duration" onClick={props.onSetDuration}>Set</button>
      </div>

      {/* Row 2: name + duration controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>Name:</span>
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g., Torch, Lantern, Light spell"
          style={{ width: 200 }}
          aria-label="Timer name"
        />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>Duration:</span>
        <input
          type="number"
          min={0}
          value={minutes}
          onChange={(e) => onMinutesChange(Math.max(0, parseInt(e.target.value || "0", 10)))}
          style={{ width: 64 }}
          aria-label="Minutes"
        />
        <span>min</span>

        <input
          type="number"
          min={0}
          max={59}
          value={seconds}
          onChange={(e) => onSecondsChange(Math.max(0, Math.min(59, parseInt(e.target.value || "0", 10))))}
          style={{ width: 64 }}
          aria-label="Seconds"
        />
        <span>sec</span>
      </div>
    </div>
  );
}
