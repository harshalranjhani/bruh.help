import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./components/ui.tsx";
import type { LanguageScoreboard, Model, RoundState, VoteInfo } from "./types.ts";
import { MODEL_LOGO_CDN_HOSTNAME } from "./utils.ts";
import "./frontend.css";

type ClientGameState = {
  lastCompleted: RoundState | null;
  active: RoundState | null;
  scores: Record<string, number>;
  viewerScores: Record<string, number>;
  languageScores: LanguageScoreboard;
  done: boolean;
  isPaused: boolean;
  generation: number;
  roundDelayMs: number;
  nextRoundAt?: number;
};

type StateMessage = {
  type: "state";
  data: ClientGameState;
  totalRounds: number;
  viewerCount: number;
  version?: string;
};

type ViewerCountMessage = {
  type: "viewerCount";
  viewerCount: number;
};

type ServerMessage = StateMessage | ViewerCountMessage;

const MODEL_COLORS: Record<string, string> = {
  "Llama 3.1 8B": "#f59e0b",
  "Gemma 2 9B": "#D97757",
  "Llama 3.3 70B": "#a78bfa",
  "DeepSeek V3": "#22d3ee",
  "Mistral Nemo": "#34d399",
  "Qwen3 8B": "#38bdf8",
  "Phi-4": "#e879f9",
  "Stack Overflow": "#f97316",
};

/** Model logo filenames on CDN - matches https://cdn.bruh.help/images/logos/<name>.png */
const MODEL_LOGO_FILENAMES: Record<string, string> = {
  "Llama 3.1 8B": "meta.png",
  "Gemma 2 9B": "google-gemini.png",
  "Llama 3.3 70B": "meta.png",
  "DeepSeek V3": "deepseek.png",
  "Mistral Nemo": "mistral-ai.png",
  "Qwen3 8B": "qwen.png",
  "Phi-4": "microsoft.png",
  // Stack Overflow not available on CDN yet
};

function colorFor(name: string) {
  return MODEL_COLORS[name] ?? "#D97757";
}

function logoFor(name: string) {
  const filename = MODEL_LOGO_FILENAMES[name];
  if (!filename) return null;
  return `${MODEL_LOGO_CDN_HOSTNAME}/images/logos/${filename}`;
}

function decodeHtmlText(text: string): string {
  if (!text.includes("&")) return text;
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => {
    if (!content) return "";
    return marked.parse(content, { async: false }) as string;
  }, [content]);
  return <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function getViewerId() {
  const key = "bruhhelp.viewer.id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function Dots() {
  return (
    <span className="inline-flex gap-0.5">
      <span className="animate-pulse">.</span>
      <span className="animate-pulse [animation-delay:120ms]">.</span>
      <span className="animate-pulse [animation-delay:240ms]">.</span>
    </span>
  );
}

function ModelTag({ model, small = false }: { model: Model; small?: boolean }) {
  const logo = logoFor(model.name);
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono"
      style={{
        color: colorFor(model.name),
        fontSize: small ? "0.74rem" : "0.82rem",
      }}
    >
      {logo ? <img src={logo} alt="" className={small ? "h-3.5 w-3.5" : "h-4 w-4"} /> : null}
      {model.name}
    </span>
  );
}

function parseJudgeVotes(round: RoundState) {
  const [contA, contB] = round.contestants;
  let votesA = 0;
  let votesB = 0;
  const votersA: VoteInfo[] = [];
  const votersB: VoteInfo[] = [];

  for (const vote of round.votes) {
    if (vote.votedFor?.name === contA.name) {
      votesA += 1;
      votersA.push(vote);
    } else if (vote.votedFor?.name === contB.name) {
      votesB += 1;
      votersB.push(vote);
    }
  }

  return {
    votesA,
    votesB,
    totalVotes: votesA + votesB,
    votersA,
    votersB,
  };
}

function ContestantCard({
  round,
  side,
  myVote,
  canVote,
  onVote,
}: {
  round: RoundState;
  side: "A" | "B";
  myVote: "A" | "B" | null;
  canVote: boolean;
  onVote: (side: "A" | "B") => void;
}) {
  const task = side === "A" ? round.answerTasks[0] : round.answerTasks[1];
  const { votesA, votesB, totalVotes, votersA, votersB } = parseJudgeVotes(round);
  const judgeVotes = side === "A" ? votesA : votesB;
  const judgePct = totalVotes > 0 ? Math.round((judgeVotes / totalVotes) * 100) : 0;
  const voters = side === "A" ? votersA : votersB;

  const viewerVotes = side === "A" ? round.viewerVotesA ?? 0 : round.viewerVotesB ?? 0;
  const totalViewerVotes = (round.viewerVotesA ?? 0) + (round.viewerVotesB ?? 0);
  const viewerPct = totalViewerVotes > 0 ? Math.round((viewerVotes / totalViewerVotes) * 100) : 0;

  const isWinner =
    round.phase === "done" &&
    ((side === "A" && votesA > votesB) || (side === "B" && votesB > votesA));
  const isSelected = myVote === side;

  return (
    <Card
      className={`flex min-h-[260px] flex-col border ${
        isWinner ? "border-orange-300/50 bg-orange-950/15" : "border-zinc-800 bg-zinc-950/70"
      } ${isSelected ? "ring-2 ring-emerald-500/70" : ""}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <ModelTag model={task.model} />
          <div className="flex items-center gap-2">
            <Badge variant="outline">{side}</Badge>
            {isSelected ? <Badge className="bg-emerald-700">Your vote</Badge> : null}
            {isWinner ? <Badge className="bg-orange-500 text-zinc-950">Winner</Badge> : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar rounded-md border border-zinc-800 bg-black/30 p-4" style={{ maxHeight: "300px" }}>
          {!task.finishedAt ? (
            <p className="text-zinc-500">
              Generating answer <Dots />
            </p>
          ) : task.error ? (
            <p className="text-sm text-red-400">{task.error}</p>
          ) : (
            <MarkdownPreview content={task.result ?? ""} />
          )}
        </div>

        {(round.phase === "voting" || round.phase === "done") && (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                <span>Judge votes</span>
                <span>{judgeVotes}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
                <div
                  className="h-full rounded transition-all duration-500"
                  style={{ width: `${judgePct}%`, background: colorFor(task.model.name) }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {voters.map((vote, idx) => (
                  <Badge key={`${vote.voter.name}-${idx}`} variant="outline" className="text-[11px]">
                    {vote.voter.name}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
                <span>Viewer votes</span>
                <span>{viewerVotes}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
                <div className="h-full rounded bg-zinc-500 transition-all duration-500" style={{ width: `${viewerPct}%` }} />
              </div>
            </div>

            {canVote ? (
              <Button variant="outline" size="sm" onClick={() => onVote(side)}>
                Vote for {task.model.name}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Arena({
  round,
  totalRounds,
  myVote,
  onVote,
  votingSecondsLeft,
}: {
  round: RoundState;
  totalRounds: number | null;
  myVote: "A" | "B" | null;
  onVote: (side: "A" | "B") => void;
  votingSecondsLeft: number;
}) {
  const canVote = round.phase === "voting" && votingSecondsLeft > 0;

  const phaseLabel =
    round.phase === "prompting"
      ? "Fetching question"
      : round.phase === "answering"
        ? "Generating answers"
        : round.phase === "voting"
          ? "Judging and public voting"
          : "Round complete";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-orange-600 text-zinc-950">Round {round.num}</Badge>
          {totalRounds && Number.isFinite(totalRounds) ? <Badge variant="outline">of {totalRounds}</Badge> : null}
          <Badge variant="outline">{round.language}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{phaseLabel}</Badge>
          {canVote ? <Badge className="bg-emerald-600 text-zinc-950">{votingSecondsLeft}s left</Badge> : null}
        </div>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/80">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <ModelTag model={round.prompter} small />
            <a href={round.question.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-xs text-orange-400 hover:bg-orange-500/20 hover:text-orange-300 transition-colors">
              View on Stack Overflow ↗
            </a>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <a href={round.question.link} target="_blank" rel="noreferrer" className="block hover:opacity-80 transition-opacity">
            <h1 className="text-2xl font-semibold leading-tight text-zinc-50 md:text-3xl">
              {decodeHtmlText(round.question.title)}
            </h1>
          </a>
          <p className="text-sm leading-6 text-zinc-300">{decodeHtmlText(round.question.bodySnippet)}</p>
          <div className="flex flex-wrap gap-2">
            {round.question.tags.slice(0, 10).map((tag) => (
              <Badge key={tag} variant="secondary" className="bg-zinc-800 text-zinc-300">
                #{tag}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {canVote ? (
        <Card className="border-emerald-800/60 bg-emerald-950/20">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm text-emerald-300">
            <p>Vote from this page by selecting one of the answers below.</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <ContestantCard round={round} side="A" myVote={myVote} canVote={canVote} onVote={onVote} />
        <ContestantCard round={round} side="B" myVote={myVote} canVote={canVote} onVote={onVote} />
      </div>

      <Card className="border-zinc-800 bg-zinc-950/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-200">Judge reasoning</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {round.votes.map((vote, idx) => (
            <div key={`${vote.voter.name}-${idx}`} className="hide-scrollbar rounded border border-zinc-800 bg-black/25 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <ModelTag model={vote.voter} small />
                {vote.votedFor ? (
                  <Badge variant="outline">Picked {vote.votedFor.name === round.contestants[0].name ? "A" : "B"}</Badge>
                ) : vote.error ? (
                  <Badge className="bg-red-800">Error</Badge>
                ) : (
                  <Badge variant="secondary">Pending</Badge>
                )}
              </div>
              <div className="text-xs leading-5 text-zinc-300">
                <MarkdownPreview content={vote.reasoning ?? "No reasoning yet."} />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

function AnswererLeaderboard({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ name: string; wins: number; rounds: number; viewerWins: number }>;
}) {
  const maxWins = Math.max(1, ...entries.map((e) => e.wins));

  return (
    <Card className="border-zinc-800 bg-zinc-950/80">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-500">AI Judges</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map((entry, index) => {
          const barPct = maxWins > 0 ? Math.max(3, Math.round((entry.wins / maxWins) * 100)) : 0;
          const logo = logoFor(entry.name);

          return (
            <div key={entry.name} className="group">
              <div className="flex items-center gap-2 py-1">
                <span className="w-5 text-right text-xs text-zinc-600">
                  {index === 0 ? "👑" : index + 1}
                </span>
                {logo ? <img src={logo} alt="" className="h-4 w-4 opacity-70" /> : <span className="h-4 w-4" />}
                <span className="truncate text-sm font-medium" style={{ color: colorFor(entry.name) }}>
                  {entry.name}
                </span>
                <span className="ml-auto text-sm font-bold text-zinc-200">{entry.wins}</span>
              </div>
              <div className="ml-7 h-1 overflow-hidden rounded-full bg-zinc-800/60">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${barPct}%`, background: colorFor(entry.name) }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function JudgeLeaderboard({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ name: string; judgeWins: number; judgeRounds: number }>;
}) {
  const maxWins = Math.max(1, ...entries.map((e) => e.judgeWins));

  return (
    <Card className="border-zinc-800 bg-zinc-950/80">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-500">Viewers</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map((entry, index) => {
          const barPct = entry.judgeWins > 0 ? Math.max(3, Math.round((entry.judgeWins / maxWins) * 100)) : 0;
          const logo = logoFor(entry.name);

          return (
            <div key={entry.name} className="group">
              <div className="flex items-center gap-2 py-1">
                <span className="w-5 text-right text-xs text-zinc-600">
                  {index === 0 ? "👑" : index + 1}
                </span>
                {logo ? <img src={logo} alt="" className="h-4 w-4 opacity-70" /> : <span className="h-4 w-4" />}
                <span className="truncate text-sm font-medium" style={{ color: colorFor(entry.name) }}>
                  {entry.name}
                </span>
                <span className="ml-auto text-sm font-bold text-zinc-200">{entry.judgeWins}</span>
              </div>
              <div className="ml-7 h-1 overflow-hidden rounded-full bg-zinc-800/60">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${barPct}%`, background: colorFor(entry.name) }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function SidePanel({
  state,
  viewerCount,
}: {
  state: ClientGameState;
  viewerCount: number;
}) {
  const selectedLanguage = "all";

  const answererEntries = useMemo(() => {
    const board = state.languageScores[selectedLanguage] ?? {};
    const allNames = new Set<string>([...Object.keys(state.scores), ...Object.keys(board)]);

    return [...allNames]
      .filter((name) => name !== "Stack Overflow")
      .map((name) => {
        const line = board[name] ?? { wins: 0, rounds: 0, viewerWins: 0, judgeWins: 0, judgeRounds: 0 };
        return {
          name,
          wins: line.wins,
          rounds: line.rounds,
          viewerWins: line.viewerWins,
        };
      })
      .sort((a, b) => (b.wins !== a.wins ? b.wins - a.wins : b.rounds - a.rounds));
  }, [state.languageScores, state.scores]);

  const judgeEntries = useMemo(() => {
    const board = state.languageScores[selectedLanguage] ?? {};
    const allNames = new Set<string>([...Object.keys(state.scores), ...Object.keys(board)]);

    return [...allNames]
      .filter((name) => name !== "Stack Overflow")
      .map((name) => {
        const line = board[name] ?? { wins: 0, rounds: 0, viewerWins: 0, judgeWins: 0, judgeRounds: 0 };
        return {
          name,
          judgeWins: line.judgeWins ?? 0,
          judgeRounds: line.judgeRounds ?? 0,
        };
      })
      .sort((a, b) => (b.judgeWins !== a.judgeWins ? b.judgeWins - a.judgeWins : b.judgeRounds - a.judgeRounds));
  }, [state.languageScores, state.scores]);

  return (
    <aside className="space-y-4 lg:sticky lg:top-4 lg:h-fit">
      <Card className="border-zinc-800 bg-zinc-950/80">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">Live viewers</span>
            <Badge className="bg-emerald-600 text-zinc-950">{viewerCount}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">Engine</span>
            <Badge variant="outline">{state.isPaused ? "Paused" : "Running"}</Badge>
          </div>
          <a className="flex items-center justify-between rounded-md border border-zinc-800 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white" href="/history">
            <span>Match history</span>
            <span className="text-zinc-500">→</span>
          </a>
        </CardContent>
      </Card>

      <AnswererLeaderboard title="Answerer standings" entries={answererEntries} />
      <JudgeLeaderboard title="Judge standings" entries={judgeEntries} />
    </aside>
  );
}

function App() {
  const [state, setState] = useState<ClientGameState | null>(null);
  const [connected, setConnected] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [totalRounds, setTotalRounds] = useState<number | null>(null);
  const [votingSecondsLeft, setVotingSecondsLeft] = useState(0);
  const [myVote, setMyVote] = useState<"A" | "B" | null>(null);

  useEffect(() => {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;
    let knownVersion: string | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 1500);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        if (msg.type === "state") {
          if (msg.version) {
            if (!knownVersion) knownVersion = msg.version;
            else if (knownVersion !== msg.version) {
              window.location.reload();
              return;
            }
          }

          setState(msg.data);
          setTotalRounds(Number.isFinite(msg.totalRounds) ? msg.totalRounds : null);
          setViewerCount(msg.viewerCount);
        } else {
          setViewerCount(msg.viewerCount);
        }
      };
    };

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    setMyVote(null);
  }, [state?.active?.num]);

  useEffect(() => {
    const endsAt = state?.active?.viewerVotingEndsAt;
    if (!endsAt || state?.active?.phase !== "voting") {
      setVotingSecondsLeft(0);
      return;
    }

    const tick = () => setVotingSecondsLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state?.active?.viewerVotingEndsAt, state?.active?.phase]);

  const displayRound = useMemo(() => {
    if (!state) return null;
    const isNextPrompting = state.active?.phase === "prompting" && !state.active.prompt;
    if (isNextPrompting && state.lastCompleted) return state.lastCompleted;
    return state.active ?? state.lastCompleted;
  }, [state]);


  async function castVote(side: "A" | "B") {
    try {
      const response = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voterId: getViewerId(),
          side,
        }),
      });

      if (response.ok) {
        setMyVote(side);
      }
    } catch {
      // Ignore transient client errors.
    }
  }

  const [delaySecondsLeft, setDelaySecondsLeft] = useState(0);

  useEffect(() => {
    const nextRoundAt = state?.nextRoundAt;
    if (!nextRoundAt) {
      setDelaySecondsLeft(0);
      return;
    }
    const tick = () => setDelaySecondsLeft(Math.max(0, Math.ceil((nextRoundAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state?.nextRoundAt, state?.generation]);

  if (!connected || !state) {
    return (
      <main className="loading-screen flex min-h-screen items-center justify-center px-4">
        <div className="space-y-2 text-center">
          <h1 className="text-4xl font-semibold text-orange-400">bruh.help</h1>
          <p className="text-sm text-zinc-500">
            Connecting to live rounds <Dots />
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell min-h-screen bg-[#090909] text-zinc-100">
      <div className="mx-auto max-w-[1500px] px-3 py-3 sm:px-4 sm:py-4 lg:px-6 lg:py-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <a href="/" className="inline-flex items-center gap-2">
            <span className="font-display text-2xl tracking-wide text-orange-400">bruh.help</span>
          </a>
          <div className="flex items-center gap-2">
            {state.isPaused ? <Badge variant="outline">Paused</Badge> : null}
            <Badge variant="outline" className="hidden sm:inline-flex">Live AI fixes for Stack Overflow errors</Badge>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <main className="min-w-0 space-y-4">
            {delaySecondsLeft > 0 ? (
              <Card className="border-sky-800/40 bg-sky-950/20">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-sky-700/50 bg-sky-900/30">
                    <span className="text-lg font-bold text-sky-400">{delaySecondsLeft}</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-sky-300">Next round starts soon!</p>
                    <p className="text-xs text-zinc-500">Delay between rounds to keep API costs low. Sit tight!</p>
                  </div>
                </CardContent>
              </Card>
            ) : null}
            {displayRound ? (
              <Arena
                round={displayRound}
                totalRounds={totalRounds}
                myVote={myVote}
                onVote={castVote}
                votingSecondsLeft={votingSecondsLeft}
              />
            ) : delaySecondsLeft <= 0 ? (
              <Card className="border-zinc-800 bg-zinc-950/80">
                <CardContent className="p-8 text-center text-zinc-400">Waiting for the next round.</CardContent>
              </Card>
            ) : null}
          </main>

          <SidePanel
            state={state}
            viewerCount={viewerCount}
          />
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
