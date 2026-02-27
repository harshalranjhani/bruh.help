import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./components/ui.tsx";
import "./admin.css";

type AdminSnapshot = {
  isPaused: boolean;
  isRunningRound: boolean;
  done: boolean;
  completedInMemory: number;
  persistedRounds: number;
  viewerCount: number;
  questionDifficulty?: "easy" | "medium" | "hard";
  roundDelayMs?: number;
};

type AdminResponse = { ok: true } & AdminSnapshot;
type Mode = "checking" | "locked" | "ready";

const RESET_TOKEN = "RESET";

async function readErrorMessage(res: Response) {
  const text = await res.text();
  return text || `Request failed (${res.status})`;
}

async function requestAdminJson(path: string, init?: RequestInit): Promise<AdminResponse> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }

  return (await res.json()) as AdminResponse;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="border-zinc-800 bg-zinc-950/80">
      <CardContent className="space-y-1 p-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
        <p className="font-display text-4xl leading-none text-zinc-100">{value}</p>
      </CardContent>
    </Card>
  );
}

function App() {
  const [mode, setMode] = useState<Mode>("checking");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");

  const busy = useMemo(() => pending !== null, [pending]);

  useEffect(() => {
    let mounted = true;

    requestAdminJson("/api/admin/status")
      .then((data) => {
        if (!mounted) return;
        setSnapshot(data);
        setMode("ready");
      })
      .catch(() => {
        if (!mounted) return;
        setSnapshot(null);
        setMode("locked");
      });

    return () => {
      mounted = false;
    };
  }, []);

  async function onLogin(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("login");
    try {
      const data = await requestAdminJson("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ passcode }),
      });
      setSnapshot(data);
      setPasscode("");
      setMode("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setPending(null);
    }
  }

  async function runControl(path: string, task: string) {
    setError(null);
    setPending(task);
    try {
      const data = await requestAdminJson(path, { method: "POST" });
      setSnapshot(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Admin action failed";
      if (message.toLowerCase().includes("unauthorized")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onExport() {
    setError(null);
    setPending("export");
    try {
      const response = await fetch("/api/admin/export", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/i);
      const fileName = match?.[1] ?? `bruh-help-export-${Date.now()}.json`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setPending(null);
    }
  }

  async function onReset() {
    setError(null);
    setPending("reset");
    try {
      const data = await requestAdminJson("/api/admin/reset", {
        method: "POST",
        body: JSON.stringify({ confirm: RESET_TOKEN }),
      });
      setSnapshot(data);
      setResetText("");
      setIsResetOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setPending(null);
    }
  }

  async function onLogout() {
    setError(null);
    setPending("logout");
    try {
      await fetch("/api/admin/logout", {
        method: "POST",
        cache: "no-store",
      });
      setSnapshot(null);
      setMode("locked");
      setPasscode("");
    } finally {
      setPending(null);
    }
  }

  if (mode === "checking") {
    return (
      <main className="admin-shell flex min-h-screen items-center justify-center px-4">
        <Card className="border-zinc-800 bg-zinc-950/80">
          <CardContent className="p-6 font-mono text-xs uppercase tracking-[0.2em] text-zinc-400">
            checking admin session...
          </CardContent>
        </Card>
      </main>
    );
  }

  if (mode === "locked") {
    return (
      <main className="admin-shell flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-md border-zinc-800 bg-zinc-950/90">
          <CardHeader>
            <a href="/" className="inline-flex items-center gap-2">
              <span className="font-display text-2xl tracking-wide text-orange-400">bruh.help</span>
            </a>
            <CardTitle className="font-mono text-xs uppercase tracking-[0.25em] text-zinc-500">secure panel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={onLogin} className="space-y-3" autoComplete="off">
              <label className="block space-y-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">passcode</span>
                <input
                  type="password"
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-orange-500"
                  required
                  autoFocus
                />
              </label>
              <Button type="submit" className="w-full" disabled={busy || !passcode.trim()}>
                {pending === "login" ? "checking..." : "unlock"}
              </Button>
            </form>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="flex gap-3 font-mono text-xs uppercase tracking-wide text-zinc-400">
              <a href="/" className="hover:text-orange-300">
                live
              </a>
              <a href="/history" className="hover:text-orange-300">
                history
              </a>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="admin-shell min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <a href="/" className="inline-flex items-center gap-2">
             <span className="font-display text-2xl tracking-wide text-orange-400">bruh.help</span>
          </a>
          <div className="flex items-center gap-2">
            <a href="/history" className="font-mono text-xs uppercase tracking-wide text-zinc-400 hover:text-orange-300">
              history
            </a>
            <Button variant="outline" size="sm" onClick={onLogout} disabled={busy}>
              logout
            </Button>
          </div>
        </header>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <CardHeader className="space-y-3">
            <CardTitle className="font-display text-5xl uppercase tracking-wide text-zinc-100">Control Room</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-orange-600 text-zinc-950">stack overflow source locked</Badge>
              <Badge variant="outline">no user prompt input enabled</Badge>
            </div>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Engine" value={snapshot?.isPaused ? "Paused" : "Live"} />
              <Stat label="Round" value={snapshot?.isRunningRound ? "Active" : "Idle"} />
              <Stat label="Rounds" value={String(snapshot?.persistedRounds ?? 0)} />
              <Stat label="Viewers" value={String(snapshot?.viewerCount ?? 0)} />
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Button
                className="w-full"
                disabled={busy || Boolean(snapshot?.isPaused)}
                onClick={() => runControl("/api/admin/pause", "pause")}
              >
                {pending === "pause" ? "pausing..." : "pause"}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                disabled={busy || !snapshot?.isPaused}
                onClick={() => runControl("/api/admin/resume", "resume")}
              >
                {pending === "resume" ? "resuming..." : "resume"}
              </Button>
              <Button variant="outline" className="w-full" disabled={busy} onClick={onExport}>
                {pending === "export" ? "exporting..." : "export"}
              </Button>
              <Button variant="outline" className="w-full border-red-700 text-red-300" disabled={busy} onClick={() => setIsResetOpen(true)}>
                reset
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <CardHeader>
            <CardTitle className="font-display text-3xl uppercase tracking-wide text-zinc-100">Question Difficulty</CardTitle>
            <p className="text-xs text-zinc-400">Controls what kind of Stack Overflow questions are fetched</p>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {(["easy", "medium", "hard"] as const).map((level) => (
                <Button
                  key={level}
                  variant={snapshot?.questionDifficulty === level ? "default" : "outline"}
                  className={`flex-1 capitalize ${snapshot?.questionDifficulty === level ? "" : ""}`}
                  disabled={busy}
                  onClick={async () => {
                    setError(null);
                    setPending("difficulty");
                    try {
                      const data = await requestAdminJson("/api/admin/difficulty", {
                        method: "POST",
                        body: JSON.stringify({ difficulty: level }),
                      });
                      setSnapshot(data);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Failed to set difficulty");
                    } finally {
                      setPending(null);
                    }
                  }}
                >
                  {pending === "difficulty" ? "..." : level}
                </Button>
              ))}
            </div>
            <div className="mt-3 space-y-1 text-xs text-zinc-500">
              <p><strong className="text-zinc-400">Easy</strong> — Popular, high-vote error questions</p>
              <p><strong className="text-zinc-400">Medium</strong> — Recent error questions across languages</p>
              <p><strong className="text-zinc-400">Hard</strong> — Fresh exception/debugging questions</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <CardHeader>
            <CardTitle className="font-display text-3xl uppercase tracking-wide text-zinc-100">Round Delay</CardTitle>
            <p className="text-xs text-zinc-400">Wait time between rounds to reduce API costs</p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {[
                { label: "None", ms: 0 },
                { label: "1 min", ms: 60_000 },
                { label: "2 min", ms: 120_000 },
                { label: "3 min", ms: 180_000 },
                { label: "5 min", ms: 300_000 },
                { label: "10 min", ms: 600_000 },
              ].map(({ label, ms }) => (
                <Button
                  key={ms}
                  variant={snapshot?.roundDelayMs === ms ? "default" : "outline"}
                  className="flex-1"
                  disabled={busy}
                  onClick={async () => {
                    setError(null);
                    setPending("delay");
                    try {
                      const data = await requestAdminJson("/api/admin/delay", {
                        method: "POST",
                        body: JSON.stringify({ delayMs: ms }),
                      });
                      setSnapshot(data);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Failed to set delay");
                    } finally {
                      setPending(null);
                    }
                  }}
                >
                  {pending === "delay" ? "..." : label}
                </Button>
              ))}
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Current: <strong className="text-zinc-400">{snapshot?.roundDelayMs ? `${Math.round((snapshot.roundDelayMs) / 60_000)} min` : "None"}</strong>. Higher delays = lower API costs.
            </p>
          </CardContent>
        </Card>
      </div>

      {isResetOpen ? (
        <div className="fixed inset-0 grid place-items-center bg-black/80 p-4">
          <Card className="w-full max-w-md border-zinc-800 bg-zinc-950/95">
            <CardHeader>
              <CardTitle className="font-display text-4xl uppercase text-zinc-100">Reset all data?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-zinc-300">
                This deletes rounds and scoreboard stats. Type <code className="rounded bg-zinc-800 px-1.5 py-0.5">{RESET_TOKEN}</code> to confirm.
              </p>
              <input
                type="text"
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-red-500"
                placeholder={RESET_TOKEN}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsResetOpen(false);
                    setResetText("");
                  }}
                  disabled={busy}
                >
                  cancel
                </Button>
                <Button
                  className="bg-red-700 text-zinc-100 hover:bg-red-600"
                  onClick={onReset}
                  disabled={busy || resetText !== RESET_TOKEN}
                >
                  {pending === "reset" ? "resetting..." : "confirm"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
