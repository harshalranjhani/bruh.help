import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./components/ui.tsx";
import type { RoundState, VoteInfo } from "./types.ts";
import { MODEL_LOGO_CDN_HOSTNAME } from "./utils.ts";
import "./history.css";

type HistoryResponse = {
  rounds: RoundState[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

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
  let filename: string | null = null;
  if (name.includes("Llama")) filename = "meta.png";
  else if (name.includes("Gemma")) filename = "google-gemma.png";
  else if (name.includes("Qwen")) filename = "qwen.png";
  else if (name.includes("DeepSeek")) filename = "deepseek.png";
  else if (name.includes("Mistral")) filename = "mistral-ai.png";
  else if (name.includes("Phi")) filename = "microsoft.png";
  if (!filename) return null;
  return `${MODEL_LOGO_CDN_HOSTNAME}/images/logos/${filename}`;
}

function colorFor(name: string) {
  if (name.includes("Llama")) return "#f59e0b";
  if (name.includes("Gemma")) return "#D97757";
  if (name.includes("Qwen")) return "#38bdf8";
  if (name.includes("Phi")) return "#e879f9";
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
        <CardTitle className="text-2xl font-semibold leading-tight text-zinc-50 md:text-3xl break-words">
          {decodeHtmlText(round.question.title)}
        </CardTitle>
        <p className="text-sm text-zinc-300 break-words">{decodeHtmlText(round.question.bodySnippet)}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Card
            className={`min-w-0 w-full border ${winnerA ? "border-orange-300/60 bg-orange-950/20" : "border-zinc-800 bg-black/40"}`}
          >
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2" style={{ color: colorFor(a.name) }}>
                  {logoFor(a.name) ? <img src={logoFor(a.name)!} alt="" className="h-4 w-4" /> : null}
                  <span className="font-medium">{a.name}</span>
                </div>
                {winnerA ? <Badge className="bg-orange-500 text-zinc-950">win</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="w-full min-w-0 hide-scrollbar overflow-y-auto overflow-x-hidden" style={{ maxHeight: "250px" }}>
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
            className={`min-w-0 w-full border ${winnerB ? "border-orange-300/60 bg-orange-950/20" : "border-zinc-800 bg-black/40"}`}
          >
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2" style={{ color: colorFor(b.name) }}>
                  {logoFor(b.name) ? <img src={logoFor(b.name)!} alt="" className="h-4 w-4" /> : null}
                  <span className="font-medium">{b.name}</span>
                </div>
                {winnerB ? <Badge className="bg-orange-500 text-zinc-950">win</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="w-full min-w-0 hide-scrollbar overflow-y-auto overflow-x-hidden" style={{ maxHeight: "250px" }}>
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

function LanguageDropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const label = value === "all" ? "All languages" : value;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
          open
            ? "border-orange-500 bg-zinc-800 text-zinc-100"
            : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
        }`}
      >
        <span>{label}</span>
        <svg
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          className={`shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl shadow-black/50">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => { onChange(option); setOpen(false); }}
              className={`flex w-full items-center px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
                option === value
                  ? "bg-orange-500/15 text-orange-400"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              }`}
            >
              {option === "all" ? "All languages" : option}
              {option === value && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="ml-auto shrink-0">
                  <path d="M1 4l3 3 5-6" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [language, setLanguage] = useState("all");
  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);

  // Fetch available languages once on mount
  useEffect(() => {
    fetch("/api/history/languages", { cache: "no-store" })
      .then((res) => res.json())
      .then((payload: { languages: string[] }) => {
        setAvailableLanguages(payload.languages ?? []);
      })
      .catch(() => {
        // Silently fall back to empty — dropdown will just show "All languages"
      });
  }, []);

  // Derived: dropdown options ("other" excluded when viewing "all")
  const dropdownOptions = useMemo(() => {
    const visibleLanguages =
      language === "all"
        ? availableLanguages.filter((l) => l !== "other")
        : availableLanguages;
    return ["all", ...visibleLanguages];
  }, [availableLanguages, language]);

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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-400">round archive · {heading}</h1>
              <LanguageDropdown
                value={language}
                options={dropdownOptions}
                onChange={setLanguage}
              />
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
