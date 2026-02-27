import { generateText } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFixPrompt,
  buildFixSystemPrompt,
  buildJudgePrompt,
  buildJudgeSystemPrompt,
} from "./prompts.ts";
import { saveRound } from "./db.ts";
import {
  initStackOverflowPool,
  nextStackOverflowQuestion,
  prefetchStackOverflowQuestions,
  resetStackOverflowPool,
  setStackOverflowLogger,
} from "./stackoverflow.ts";
import type {
  GameState,
  LanguageScoreboard,
  Model,
  ModelScoreLine,
  RoundState,
  StackOverflowQuestion,
} from "./types.ts";
import { shuffle, sleep, safeJsonParse } from "./utils.ts";

export const SYSTEM_MODEL: Model = {
  id: "stackoverflow/recent-errors",
  name: "Stack Overflow",
  role: "system",
};
export const NAME_PAD = 20;
export const VIEWER_VOTING_WINDOW_MS = 30_000;

type AIProvider = "groq" | "openrouter" | "openai-compatible";
const providerRaw = (process.env.AI_PROVIDER ?? "groq").trim().toLowerCase();
if (
  providerRaw !== "groq" &&
  providerRaw !== "openrouter" &&
  providerRaw !== "openai-compatible"
) {
  throw new Error(
    `Invalid AI_PROVIDER "${providerRaw}". Use groq, openrouter, or openai-compatible.`,
  );
}
export const ACTIVE_AI_PROVIDER: AIProvider = providerRaw;

type ModelPreset = { id: string; name: string; fallbackIds?: string[] };

const MODEL_PRESETS: Record<AIProvider, ModelPreset[]> = {
  groq: [
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B" },
    { id: "gemma2-9b-it", name: "Gemma 2 9B" },
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", fallbackIds: ["llama-3.1-8b-instant"] },
    { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B v2" },
    { id: "gemma2-9b-it", name: "Gemma 2 9B v2" },
    { id: "gemma2-9b-it", name: "Phi-4" },
  ],
  openrouter: [
    { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B" },
    { id: "google/gemma-2-9b-it", name: "Gemma 2 9B" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "deepseek/deepseek-chat", name: "DeepSeek V3", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "mistralai/mistral-nemo", name: "Mistral Nemo", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "qwen/qwen3-8b", name: "Qwen3 8B", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "microsoft/phi-4", name: "Phi-4", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
  ],
  "openai-compatible": [
    { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B" },
    { id: "google/gemma-2-9b-it", name: "Gemma 2 9B" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "deepseek/deepseek-chat", name: "DeepSeek V3", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "mistralai/mistral-nemo", name: "Mistral Nemo", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "qwen/qwen3-8b", name: "Qwen3 8B", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
    { id: "microsoft/phi-4", name: "Phi-4", fallbackIds: ["meta-llama/llama-3.1-8b-instruct"] },
  ],
};

const activeModels = MODEL_PRESETS[ACTIVE_AI_PROVIDER];

/** All 7 models. Each round, 2 are randomly picked as contestants and 5 as judges. */
export const ALL_MODELS: Model[] = activeModels.map((preset) => ({
  id: preset.id,
  name: preset.name,
  role: "contestant" as const,
  fallbackIds: preset.fallbackIds,
}));

// Legacy exports for backward compat
export const CONTESTANT_MODELS = ALL_MODELS;
export const JUDGE_MODELS = ALL_MODELS;
export const MODELS = ALL_MODELS;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const groqClient =
  ACTIVE_AI_PROVIDER === "groq"
    ? createGroq({
        apiKey: requireEnv("GROQ_API_KEY"),
      })
    : null;

const openRouterHeaders: Record<string, string> = {};
if (process.env.OPENROUTER_SITE_URL?.trim()) {
  openRouterHeaders["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL.trim();
}
if (process.env.OPENROUTER_APP_NAME?.trim()) {
  openRouterHeaders["X-Title"] = process.env.OPENROUTER_APP_NAME.trim();
}

const openRouterClient =
  ACTIVE_AI_PROVIDER === "openrouter"
    ? createOpenAI({
        apiKey: requireEnv("OPENROUTER_API_KEY"),
        baseURL: process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
        headers: openRouterHeaders,
      })
    : null;

const openAICompatibleHeaders = safeJsonParse<Record<string, string>>(
  process.env.OPENAI_COMPATIBLE_HEADERS_JSON ?? "",
  {},
);

const openAICompatibleClient =
  ACTIVE_AI_PROVIDER === "openai-compatible"
    ? createOpenAI({
        apiKey: requireEnv("OPENAI_COMPATIBLE_API_KEY"),
        baseURL: requireEnv("OPENAI_COMPATIBLE_BASE_URL"),
        headers: openAICompatibleHeaders,
      })
    : null;

function resolveProviderModel(modelId: string) {
  if (ACTIVE_AI_PROVIDER === "groq") {
    return groqClient!(modelId);
  }
  if (ACTIVE_AI_PROVIDER === "openrouter") {
    return openRouterClient!(modelId);
  }
  return openAICompatibleClient!(modelId);
}

const LOGS_DIR = join(import.meta.dir, "logs");
mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = join(
  LOGS_DIR,
  `game-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
);

export { LOG_FILE };

export function log(
  level: "INFO" | "WARN" | "ERROR",
  category: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const ts = new Date().toISOString();
  let line = `[${ts}] ${level} [${category}] ${message}`;
  if (data) {
    line += ` ${JSON.stringify(data)}`;
  }
  appendFileSync(LOG_FILE, `${line}\n`);

  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

setStackOverflowLogger(log);
log("INFO", "provider", "AI provider configured", {
  provider: ACTIVE_AI_PROVIDER,
  models: ALL_MODELS.map((m) => m.name),
});

export function createBlankScores() {
  return Object.fromEntries(ALL_MODELS.map((model) => [model.name, 0]));
}

export function createBlankJudgeScores() {
  return Object.fromEntries(ALL_MODELS.map((model) => [model.name, 0]));
}

function createEmptyLanguageLine(): ModelScoreLine {
  return { wins: 0, rounds: 0, viewerWins: 0, judgeWins: 0, judgeRounds: 0 };
}

export function createEmptyLanguageScores(): LanguageScoreboard {
  return { all: {} };
}

function ensureLanguageLine(
  board: LanguageScoreboard,
  language: string,
  modelName: string,
): ModelScoreLine {
  if (!board[language]) {
    board[language] = {};
  }
  if (!board[language]![modelName]) {
    board[language]![modelName] = createEmptyLanguageLine();
  }
  return board[language]![modelName]!;
}

function applyRoundToLanguageScores(state: GameState, round: RoundState) {
  const [a, b] = round.contestants;
  const languages = ["all", round.language || "other"];

  for (const language of languages) {
    ensureLanguageLine(state.languageScores, language, a.name).rounds += 1;
    ensureLanguageLine(state.languageScores, language, b.name).rounds += 1;

    if (round.winningModel === a.name) {
      ensureLanguageLine(state.languageScores, language, a.name).wins += 1;
    } else if (round.winningModel === b.name) {
      ensureLanguageLine(state.languageScores, language, b.name).wins += 1;
    }

    if (round.winningViewerModel === a.name) {
      ensureLanguageLine(state.languageScores, language, a.name).viewerWins += 1;
    } else if (round.winningViewerModel === b.name) {
      ensureLanguageLine(state.languageScores, language, b.name).viewerWins += 1;
    }

    // Track judge stats
    for (const vote of round.votes) {
      if (!vote.votedFor) continue;
      const judgeName = vote.voter.name;
      const line = ensureLanguageLine(state.languageScores, language, judgeName);
      line.judgeRounds += 1;
      // "correct" = picked the same model that won the round
      if (round.winningModel && vote.votedFor.name === round.winningModel) {
        line.judgeWins += 1;
      }
    }
  }
}

export function bootstrapStateFromRounds(
  rounds: RoundState[],
  state: Pick<GameState, "scores" | "viewerScores" | "languageScores">,
) {
  state.scores = createBlankScores();
  state.viewerScores = createBlankScores();
  state.languageScores = createEmptyLanguageScores();

  for (const round of rounds) {
    const winner = round.winningModel;
    if (winner && winner in state.scores) {
      state.scores[winner] = (state.scores[winner] ?? 0) + 1;
    }

    const viewerWinner = round.winningViewerModel;
    if (viewerWinner && viewerWinner in state.viewerScores) {
      state.viewerScores[viewerWinner] =
        (state.viewerScores[viewerWinner] ?? 0) + 1;
    }

    applyRoundToLanguageScores(state as GameState, round);
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  retries = 3,
  label = "unknown",
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) {
        if (attempt > 1) {
          log("INFO", label, `Succeeded on retry #${attempt}`);
        }
        return result;
      }
      lastError = new Error(`Validation failed for ${label}`);
      log("WARN", label, `Validation failed on attempt ${attempt}/${retries}`);
    } catch (error) {
      lastError = error;
      log("WARN", label, `Attempt ${attempt}/${retries} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (attempt < retries) {
      await sleep(600 * attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`All retries failed for ${label}`);
}

function isRealString(value: string, minLength = 5): boolean {
  return value.trim().length >= minLength;
}

function cleanResponse(value: string): string {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

async function generateWithFallback(
  model: Model,
  system: string,
  prompt: string,
): Promise<{ text: string; modelIdUsed: string }> {
  const candidates = [model.id, ...(model.fallbackIds ?? [])];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const result = await generateText({
        model: resolveProviderModel(candidate),
        system,
        prompt,
        temperature: 0.35,
      });
      const text = cleanResponse(result.text);
      if (!text) {
        throw new Error(`Empty response from ${candidate}`);
      }
      return { text, modelIdUsed: candidate };
    } catch (error) {
      lastError = error;
      log("WARN", `model:${model.name}`, "Model candidate failed", {
        candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`All model candidates failed for ${model.name}`);
}

export async function callGenerateAnswer(
  model: Model,
  question: StackOverflowQuestion,
): Promise<string> {
  const system = buildFixSystemPrompt();
  const prompt = buildFixPrompt(question);

  const { text, modelIdUsed } = await generateWithFallback(model, system, prompt);

  log("INFO", `answer:${model.name}`, "Generated contestant answer", {
    modelIdUsed,
    questionId: question.questionId,
    chars: text.length,
  });

  return text;
}

export async function callVote(
  judge: Model,
  question: StackOverflowQuestion,
  answerA: string,
  answerB: string,
): Promise<{ vote: "A" | "B"; reason: string }> {
  const system = buildJudgeSystemPrompt();
  const prompt = buildJudgePrompt(question, answerA, answerB);
  const { text, modelIdUsed } = await generateWithFallback(judge, system, prompt);

  const parsed = safeJsonParse<{ vote?: string; reason?: string }>(text, {});
  const voteRaw = String(parsed.vote ?? "").trim().toUpperCase();
  const reasonRaw = String(parsed.reason ?? "").trim();

  if ((voteRaw === "A" || voteRaw === "B") && reasonRaw.length > 0) {
    return { vote: voteRaw, reason: reasonRaw.slice(0, 180) };
  }

  const fallbackVote = text.toUpperCase().includes("\"B\"") || /^B\b/.test(text.trim()) ? "B" : "A";
  const fallbackReason = reasonRaw || "Picked for better technical accuracy.";

  log("WARN", `judge:${judge.name}`, "Judge output required fallback parsing", {
    modelIdUsed,
    raw: text.slice(0, 300),
  });

  return { vote: fallbackVote, reason: fallbackReason.slice(0, 180) };
}

export async function runGame(
  runs: number,
  state: GameState,
  rerender: () => void,
  onViewerVotingStart?: (round: RoundState) => void,
) {
  await initStackOverflowPool();

  let startRound = state.completed.at(-1)?.num ? state.completed.at(-1)!.num + 1 : 1;
  let endRound = runs === Infinity ? Infinity : startRound + runs - 1;

  for (let r = startRound; r <= endRound; r++) {
    while (state.isPaused) {
      await sleep(1000);
    }

    const roundGeneration = state.generation;

    const expectedRound = state.completed.at(-1)?.num
      ? state.completed.at(-1)!.num + 1
      : 1;
    if (r !== expectedRound) {
      r = expectedRound;
      endRound = runs === Infinity ? Infinity : r + runs - 1;
    }

    let question: StackOverflowQuestion;
    try {
      question = await nextStackOverflowQuestion();
    } catch (error) {
      log("ERROR", "round", "Failed to get Stack Overflow question", {
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(65_000);
      r -= 1;
      continue;
    }

    // Randomly assign roles: 2 contestants, 4 judges
    const shuffledModels = shuffle([...ALL_MODELS]);
    const [contA, contB] = shuffledModels.slice(0, 2) as [Model, Model];
    const judges = shuffledModels.slice(2) as Model[];
    const promptText = `${question.title}\n\n${question.bodySnippet}`;

    const now = Date.now();
    const round: RoundState = {
      num: r,
      phase: "prompting",
      prompter: SYSTEM_MODEL,
      promptTask: {
        model: SYSTEM_MODEL,
        startedAt: now,
      },
      prompt: undefined,
      question,
      language: question.language,
      contestants: [contA, contB],
      answerTasks: [
        { model: contA, startedAt: 0 },
        { model: contB, startedAt: 0 },
      ],
      votes: [],
      viewerVotesA: 0,
      viewerVotesB: 0,
    };

    state.active = round;
    rerender();

    await sleep(250);
    if (state.generation !== roundGeneration) {
      continue;
    }

    round.promptTask.finishedAt = Date.now();
    round.promptTask.result = promptText;
    round.prompt = promptText;

    round.phase = "answering";
    const answerStart = Date.now();
    round.answerTasks[0].startedAt = answerStart;
    round.answerTasks[1].startedAt = answerStart;
    rerender();

    await Promise.all(
      round.answerTasks.map(async (task) => {
        if (state.generation !== roundGeneration) return;

        try {
          const answer = await withRetry(
            () => callGenerateAnswer(task.model, question),
            (text) => isRealString(text, 20),
            3,
            `R${r}:answer:${task.model.name}`,
          );
          task.result = answer;
        } catch {
          task.error = "Failed to generate fix";
          task.result = "Root cause unclear, your stack trace is cooked. Verify dependencies and exact line numbers.";
        }

        task.finishedAt = Date.now();
        rerender();
      }),
    );

    if (state.generation !== roundGeneration) {
      continue;
    }

    round.phase = "voting";
    const answerA = round.answerTasks[0].result ?? "No answer";
    const answerB = round.answerTasks[1].result ?? "No answer";

    round.votes = judges.map((judge) => ({
      voter: judge,
      startedAt: Date.now(),
    }));

    round.viewerVotesA = 0;
    round.viewerVotesB = 0;
    round.viewerVotingEndsAt = Date.now() + VIEWER_VOTING_WINDOW_MS;
    onViewerVotingStart?.(round);
    rerender();

    await Promise.all([
      Promise.all(
        round.votes.map(async (voteInfo) => {
          if (state.generation !== roundGeneration) return;

          try {
            const showAFirst = Math.random() > 0.5;
            const first = showAFirst ? answerA : answerB;
            const second = showAFirst ? answerB : answerA;

            const judged = await withRetry(
              () => callVote(voteInfo.voter, question, first, second),
              (value) => value.vote === "A" || value.vote === "B",
              3,
              `R${r}:vote:${voteInfo.voter.name}`,
            );

            const voteForA = showAFirst ? judged.vote === "A" : judged.vote === "B";
            voteInfo.votedFor = voteForA ? contA : contB;

            // Remap A/B references in reasoning to match actual displayed sides
            // when answers were shown in swapped order
            let reason = judged.reason;
            if (!showAFirst) {
              reason = reason
                .replace(/\bAnswer A\b/gi, "Answer §B§")
                .replace(/\bAnswer B\b/gi, "Answer A")
                .replace(/§B§/g, "B");
            }
            voteInfo.reasoning = reason;
          } catch {
            voteInfo.error = true;
          }

          voteInfo.finishedAt = Date.now();
          rerender();
        }),
      ),
      sleep(VIEWER_VOTING_WINDOW_MS),
    ]);

    if (state.generation !== roundGeneration) {
      continue;
    }

    let votesA = 0;
    let votesB = 0;
    for (const vote of round.votes) {
      if (vote.votedFor?.name === contA.name) votesA += 1;
      if (vote.votedFor?.name === contB.name) votesB += 1;
    }

    round.scoreA = votesA * 100;
    round.scoreB = votesB * 100;
    round.phase = "done";

    if (votesA > votesB) {
      state.scores[contA.name] = (state.scores[contA.name] ?? 0) + 1;
      round.winningModel = contA.name;
    } else if (votesB > votesA) {
      state.scores[contB.name] = (state.scores[contB.name] ?? 0) + 1;
      round.winningModel = contB.name;
    } else {
      round.winningModel = null;
    }

    const viewerA = round.viewerVotesA ?? 0;
    const viewerB = round.viewerVotesB ?? 0;
    if (viewerA > viewerB) {
      state.viewerScores[contA.name] = (state.viewerScores[contA.name] ?? 0) + 1;
      round.winningViewerModel = contA.name;
    } else if (viewerB > viewerA) {
      state.viewerScores[contB.name] = (state.viewerScores[contB.name] ?? 0) + 1;
      round.winningViewerModel = contB.name;
    } else {
      round.winningViewerModel = null;
    }

    applyRoundToLanguageScores(state, round);
    rerender();

    await sleep(5000);
    if (state.generation !== roundGeneration) {
      continue;
    }

    await saveRound(round);
    state.completed = [...state.completed, round];
    state.active = null;
    rerender();

    void prefetchStackOverflowQuestions(5);

    // Configurable delay between rounds
    if (state.roundDelayMs > 0) {
      state.nextRoundAt = Date.now() + state.roundDelayMs;
      rerender();

      while (Date.now() < (state.nextRoundAt ?? 0)) {
        if (state.generation !== roundGeneration) break;
        if (state.isPaused) break;
        await sleep(1000);
        rerender();
      }

      state.nextRoundAt = undefined;
      rerender();
    }
  }

  if (runs !== Infinity) {
    state.done = true;
    rerender();
  }
}

export function resetExternalStateAfterAdminReset() {
  resetStackOverflowPool();
}
