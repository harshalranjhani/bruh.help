import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./components/ui.tsx";
import type { RoundState, VoteInfo } from "./types.ts";
import "./history.css";

type HistoryResponse = {
  rounds: RoundState[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const LANGUAGE_OPTIONS = ["all", "javascript", "typescript", "python", "go", "rust", "java", "other"];

marked.setOptions({ breaks: true, gfm: true });

function decodeHtmlText(text: string): string {
  if (!text.includes("&")) return text;
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => {
    if (!content) return "";
    return marked.parse(content, { async: false }) as string;
  }, [content]);
  return <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function logoFor(name: string) {
  if (name.includes("Llama")) return "/assets/logos/llama.svg";
  if (name.includes("Gemma")) return "/assets/logos/gemma.svg";
  if (name.includes("Qwen")) return "/assets/logos/qwen.svg";
  if (name.includes("DeepSeek")) return "/assets/logos/deepseek.svg";
  if (name.includes("Mistral")) return "/assets/logos/mistral.svg";
  if (name.includes("Phi")) return "/assets/logos/phi.svg";
  if (name.includes("Stack Overflow")) return "/assets/logos/stackoverflow.svg";
  return null;
}

function colorFor(name: string) {
  if (name.includes("Llama")) return "#f59e0b";
  if (name.includes("Gemma")) return "#D97757";
  if (name.includes("Qwen")) return "#38bdf8";
  return "#a1a1aa";
}

function JudgeChips({ votes, modelName }: { votes: VoteInfo[]; modelName: string }) {
  const filtered = votes.filter((vote) => vote.votedFor?.name === modelName);
  if (filtered.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {filtered.map((vote, index) => (
        <Badge key={`${vote.voter.name}-${index}`} variant="outline" className="text-[10px]">
          {vote.voter.name}
        </Badge>
      ))}
    </div>
  );
}

function RoundCard({ round }: { round: RoundState }) {
  const [a, b] = round.contestants;

  let votesA = 0;
  let votesB = 0;
  for (const vote of round.votes) {
    if (vote.votedFor?.name === a.name) votesA += 1;
    if (vote.votedFor?.name === b.name) votesB += 1;
  }

  const winnerA = votesA > votesB;
  const winnerB = votesB > votesA;

  return (
    <Card className="history-card border-zinc-800 bg-zinc-950/90">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge className="bg-orange-600 text-zinc-950">round {round.num}</Badge>
            <Badge variant="outline">{round.language}</Badge>
          </div>
          <a
            href={round.question.link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-xs text-orange-400 hover:bg-orange-500/20 hover:text-orange-300 transition-colors"
          >
            View on Stack Overflow ↗
          </a>
        </div>
        <CardTitle className="text-2xl font-semibold leading-tight text-zinc-50 md:text-3xl">
          {decodeHtmlText(round.question.title)}
        </CardTitle>
        <p className="text-sm text-zinc-300">{decodeHtmlText(round.question.bodySnippet)}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Card
            className={`border ${winnerA ? "border-orange-300/60 bg-orange-950/20" : "border-zinc-800 bg-black/40"}`}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2" style={{ color: colorFor(a.name) }}>
                  {logoFor(a.name) ? <img src={logoFor(a.name)!} alt="" className="h-4 w-4" /> : null}
                  <span className="font-medium">{a.name}</span>
                </div>
                {winnerA ? <Badge className="bg-orange-500 text-zinc-950">win</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="hide-scrollbar overflow-y-auto" style={{ maxHeight: "250px" }}>
                <MarkdownPreview content={round.answerTasks[0].result ?? ""} />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between font-mono text-xs text-zinc-400">
                  <span>judge votes</span>
                  <span>{votesA}</span>
                </div>
                <JudgeChips votes={round.votes} modelName={a.name} />
                <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                  viewer votes: {round.viewerVotesA ?? 0}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card
            className={`border ${winnerB ? "border-orange-300/60 bg-orange-950/20" : "border-zinc-800 bg-black/40"}`}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2" style={{ color: colorFor(b.name) }}>
                  {logoFor(b.name) ? <img src={logoFor(b.name)!} alt="" className="h-4 w-4" /> : null}
                  <span className="font-medium">{b.name}</span>
                </div>
                {winnerB ? <Badge className="bg-orange-500 text-zinc-950">win</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="hide-scrollbar overflow-y-auto" style={{ maxHeight: "250px" }}>
                <MarkdownPreview content={round.answerTasks[1].result ?? ""} />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between font-mono text-xs text-zinc-400">
                  <span>judge votes</span>
                  <span>{votesB}</span>
                </div>
                <JudgeChips votes={round.votes} modelName={b.name} />
                <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                  viewer votes: {round.viewerVotesB ?? 0}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-zinc-800 bg-black/40">
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-400">
              Did this fix actually work?
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-zinc-300">
              Check the original Stack Overflow thread for accepted answers and comments to validate outcome.
            </p>
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}

function App() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [language, setLanguage] = useState("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const query = new URLSearchParams({
      page: String(page),
      limit: "8",
    });
    if (language !== "all") {
      query.set("language", language);
    }

    fetch(`/api/history?${query.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(await res.text());
        }
        return (await res.json()) as HistoryResponse;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load history");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, language]);

  useEffect(() => {
    setPage(1);
  }, [language]);

  const hasPrev = page > 1;
  const hasNext = Boolean(data && page < data.totalPages);

  const heading = useMemo(() => {
    if (language === "all") return "all languages";
    return language;
  }, [language]);

  return (
    <main className="history-shell min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <a href="/" className="inline-flex items-center gap-2">
            <span className="font-display text-2xl tracking-wide text-orange-400">bruh.help</span>
          </a>
          <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-wide text-zinc-400">
            <a href="/" className="hover:text-orange-300">
              live arena
            </a>
          </div>
        </header>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-400">round archive · {heading}</h1>
              <div className="flex flex-wrap gap-2">
                {LANGUAGE_OPTIONS.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === language ? "default" : "outline"}
                    onClick={() => setLanguage(option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            </div>

            {loading ? <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">loading rounds...</p> : null}
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            {!loading && !error && data?.rounds.length === 0 ? (
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">no rounds in this language yet</p>
            ) : null}
          </CardContent>
        </Card>

        {!loading && !error && data?.rounds.length ? (
          <div className="space-y-4">
            {data.rounds.map((round) => (
              <RoundCard key={`${round.num}-${round.question.questionId}`} round={round} />
            ))}
          </div>
        ) : null}

        {data ? (
          <Card className="border-zinc-800 bg-zinc-950/85">
            <CardContent className="flex items-center justify-center gap-3 p-4">
              <Button variant="outline" onClick={() => setPage((value) => value - 1)} disabled={!hasPrev}>
                prev
              </Button>
              <span className="font-mono text-xs uppercase tracking-wide text-zinc-400">
                page {page} / {data.totalPages}
              </span>
              <Button variant="outline" onClick={() => setPage((value) => value + 1)} disabled={!hasNext}>
                next
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
