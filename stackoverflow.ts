import {
  getCachedStackOverflowQuestions,
  getUsedQuestionIds,
  upsertStackOverflowQuestions,
} from "./db.ts";
import type { StackOverflowQuestion } from "./types.ts";
import { sleep, shuffle } from "./utils.ts";

type LogLevel = "INFO" | "WARN" | "ERROR";

type Logger = (
  level: LogLevel,
  category: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

export type QuestionDifficulty = "easy" | "medium" | "hard";

const STACKEXCHANGE_BASE_SEARCH = "https://api.stackexchange.com/2.3/search";
const STACKEXCHANGE_BASE_QUESTIONS = "https://api.stackexchange.com/2.3/questions";
const STACKEXCHANGE_SITE = "stackoverflow";
const STACKEXCHANGE_FILTER = "withbody";
const STACKEXCHANGE_PAGE_SIZE = 100;
const IDENTICAL_QUERY_MIN_INTERVAL_MS = 30_000;
const PREFETCH_TARGET = 5;

const LANGUAGE_TAGS = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "c#",
  "cpp",
  "c++",
  "kotlin",
  "swift",
] as const;

const LANGUAGE_TAG_ALIASES: Record<string, string> = {
  "node.js": "javascript",
  nodejs: "javascript",
  reactjs: "javascript",
  "next.js": "javascript",
  vuejs: "javascript",
  "vue.js": "javascript",
  angular: "javascript",
  express: "javascript",
  "spring-boot": "java",
  spring: "java",
  golang: "go",
  django: "python",
  flask: "python",
  fastapi: "python",
};

const ERROR_HINT_TAGS = ["error", "exception", "bug", "debugging"] as const;

const requestTimestamps: number[] = [];
const lastPollByKey = new Map<string, number>();
const backoffUntilByKey = new Map<string, number>();

let logger: Logger = () => {};
let queue: StackOverflowQuestion[] = [];
let usedQuestionIds: Set<number> = new Set();
let usedIdsLoaded = false;
let inFlightFetch: Promise<StackOverflowQuestion[]> | null = null;
let initialized = false;
let currentDifficulty: QuestionDifficulty = "easy";
let currentPage = 1;

function decodeHtmlEntities(input: string): string {
  const namedMap: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return input.replace(/&#?(x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const raw = isHex ? entity.slice(2) : entity.slice(1);
      const codepoint = Number.parseInt(raw, isHex ? 16 : 10);
      if (Number.isFinite(codepoint) && codepoint > 0) {
        try {
          return String.fromCodePoint(codepoint);
        } catch {
          return full;
        }
      }
      return full;
    }

    return namedMap[entity] ?? full;
  });
}

function stripHtml(input: string): string {
  const stripped = input
    .replace(/<pre><code>[\s\S]*?<\/code><\/pre>/gi, " [code omitted] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  return decodeHtmlEntities(stripped).trim();
}

function normalizeLanguage(tags: string[]): string {
  const lower = tags.map((tag) => tag.toLowerCase());
  for (const tag of LANGUAGE_TAGS) {
    if (lower.includes(tag)) {
      if (tag === "c#") return "csharp";
      if (tag === "c++" || tag === "cpp") return "cpp";
      return tag;
    }
  }
  for (const tag of lower) {
    const alias = LANGUAGE_TAG_ALIASES[tag];
    if (alias) return alias;
  }
  return "other";
}

function isErrorLikeQuestion(tags: string[], title: string): boolean {
  const lowerTags = new Set(tags.map((tag) => tag.toLowerCase()));
  const hasLanguage = normalizeLanguage(tags) !== "other";
  const hasErrorTag = ERROR_HINT_TAGS.some((tag) => lowerTags.has(tag));
  const titleLower = title.toLowerCase();
  const titleLooksLikeError =
    titleLower.includes("error") ||
    titleLower.includes("exception") ||
    titleLower.includes("failed") ||
    titleLower.includes("undefined") ||
    titleLower.includes("not working") ||
    titleLower.includes("cannot") ||
    titleLower.includes("how to") ||
    titleLower.includes("issue") ||
    titleLower.includes("problem") ||
    titleLower.includes("fix");

  return hasLanguage && (hasErrorTag || titleLooksLikeError);
}

async function throttleStackExchange() {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length > 0 && now - requestTimestamps[0]! >= 1000) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < 30) {
      requestTimestamps.push(now);
      return;
    }
    const waitFor = Math.max(5, 1000 - (now - requestTimestamps[0]!));
    await sleep(waitFor);
  }
}

function buildQuestionsUrl(difficulty: QuestionDifficulty, page: number): URL {
  let url: URL;

  switch (difficulty) {
    case "easy": {
      // Popular, well-answered questions sorted by votes
      url = new URL(STACKEXCHANGE_BASE_SEARCH);
      url.searchParams.set("site", STACKEXCHANGE_SITE);
      url.searchParams.set("sort", "votes");
      url.searchParams.set("order", "desc");
      url.searchParams.set("pagesize", String(STACKEXCHANGE_PAGE_SIZE));
      url.searchParams.set("filter", STACKEXCHANGE_FILTER);
      url.searchParams.set("tagged", "javascript;python;java;typescript");
      url.searchParams.set("intitle", "error");
      url.searchParams.set("page", String(page));
      break;
    }
    case "medium": {
      // Recent questions with error-like content
      url = new URL(STACKEXCHANGE_BASE_SEARCH);
      url.searchParams.set("site", STACKEXCHANGE_SITE);
      url.searchParams.set("sort", "creation");
      url.searchParams.set("order", "desc");
      url.searchParams.set("pagesize", String(STACKEXCHANGE_PAGE_SIZE));
      url.searchParams.set("filter", STACKEXCHANGE_FILTER);
      url.searchParams.set("tagged", "javascript;python;java;typescript;go;rust");
      url.searchParams.set("intitle", "error");
      url.searchParams.set("page", String(page));
      break;
    }
    case "hard": {
      // Very recent, diverse error questions
      url = new URL(STACKEXCHANGE_BASE_SEARCH);
      url.searchParams.set("site", STACKEXCHANGE_SITE);
      url.searchParams.set("sort", "creation");
      url.searchParams.set("order", "desc");
      url.searchParams.set("pagesize", String(STACKEXCHANGE_PAGE_SIZE));
      url.searchParams.set("filter", STACKEXCHANGE_FILTER);
      url.searchParams.set("tagged", "javascript;python;java;rust;go;c++;kotlin;swift");
      url.searchParams.set("intitle", "exception");
      url.searchParams.set("page", String(page));
      break;
    }
  }

  const key = process.env.STACK_EXCHANGE_KEY?.trim();
  if (key) {
    url.searchParams.set("key", key);
  }

  return url;
}

function sanitizeUrlForLogs(url: URL): string {
  const copy = new URL(url.toString());
  if (copy.searchParams.has("key")) {
    copy.searchParams.set("key", "[redacted]");
  }
  return copy.toString();
}

type StackExchangeItem = {
  question_id: number;
  creation_date: number;
  title: string;
  body: string;
  link: string;
  tags: string[];
};

type StackExchangeResponse = {
  items?: StackExchangeItem[];
  backoff?: number;
  quota_remaining?: number;
  has_more?: boolean;
  error_id?: number;
  error_name?: string;
  error_message?: string;
};

async function fetchQuestions(): Promise<StackOverflowQuestion[]> {
  const queryKey = `${currentDifficulty}:${currentPage}`;
  const now = Date.now();
  const backoffUntil = backoffUntilByKey.get(queryKey) ?? 0;
  if (now < backoffUntil) {
    const waitMs = backoffUntil - now;
    logger("WARN", "stackexchange", "Backoff active, delaying query", { waitMs });
    await sleep(waitMs);
  }

  const lastPoll = lastPollByKey.get(queryKey) ?? 0;
  const elapsed = now - lastPoll;
  if (elapsed < IDENTICAL_QUERY_MIN_INTERVAL_MS) {
    // Instead of returning empty, advance to next page
    currentPage += 1;
    if (currentPage > 25) currentPage = 1;
    logger("INFO", "stackexchange", "Advancing to next page due to cooldown", {
      page: currentPage,
      difficulty: currentDifficulty,
    });
  }

  await throttleStackExchange();

  const url = buildQuestionsUrl(currentDifficulty, currentPage);
  lastPollByKey.set(`${currentDifficulty}:${currentPage}`, Date.now());

  logger("INFO", "stackexchange", "Fetching Stack Overflow questions", {
    request: sanitizeUrlForLogs(url),
    difficulty: currentDifficulty,
    page: currentPage,
  });

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "bruh.help/1.0 (contact: admin@bruh.help)",
    },
  });

  if (response.status === 429) {
    const retryAfterHeader = Number.parseInt(
      response.headers.get("retry-after") ?? "",
      10,
    );
    const payload429 = (await response.json().catch(() => null)) as
      | StackExchangeResponse
      | null;
    const payloadBackoff = Number(payload429?.backoff ?? 0);
    const backoffSeconds = Math.max(
      Number.isFinite(retryAfterHeader) ? retryAfterHeader : 0,
      Number.isFinite(payloadBackoff) ? payloadBackoff : 0,
      120,
    );
    backoffUntilByKey.set(queryKey, Date.now() + backoffSeconds * 1000);
    logger("WARN", "stackexchange", "Rate-limited (429), applying backoff", {
      backoffSeconds,
      error: payload429?.error_message,
    });
    return [];
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const parsed = safeParseStackExchangeError(raw);
    const details =
      parsed.error_message ?? (raw && raw.trim().length > 0 ? raw : "unknown error");
    throw new Error(
      `Stack Exchange request failed (${response.status}): ${details}`,
    );
  }

  const payload = (await response.json()) as StackExchangeResponse;
  if (typeof payload.backoff === "number" && payload.backoff > 0) {
    backoffUntilByKey.set(queryKey, Date.now() + payload.backoff * 1000);
  }

  if (payload.error_id) {
    throw new Error(
      payload.error_message ?? `Stack Exchange error ${payload.error_id}`,
    );
  }

  const items = payload.items ?? [];

  // Advance page for next fetch to avoid re-fetching same results
  if (payload.has_more) {
    currentPage += 1;
    if (currentPage > 25) currentPage = 1;
  } else {
    currentPage = 1;
  }

  // Parse and filter
  const parsed = items
    .map((item) => {
      const language = normalizeLanguage(item.tags);
      if (language === "other") return null;
      const body = stripHtml(item.body ?? "");
      const bodySnippet = body.slice(0, 300);
      if (!item.title?.trim() || bodySnippet.length <= 20) return null;
      return {
        questionId: item.question_id,
        title: decodeHtmlEntities(item.title.trim()),
        bodySnippet,
        link: item.link,
        tags: item.tags,
        language,
        creationDate: item.creation_date,
      } satisfies StackOverflowQuestion;
    })
    .filter((item): item is StackOverflowQuestion => Boolean(item));

  logger("INFO", "stackexchange", "Fetched Stack Overflow questions", {
    difficulty: currentDifficulty,
    page: currentPage - 1,
    fetched: items.length,
    filtered: parsed.length,
    quotaRemaining: payload.quota_remaining,
  });

  return parsed;
}

function safeParseStackExchangeError(raw: string): Partial<StackExchangeResponse> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StackExchangeResponse;
  } catch {
    return {};
  }
}

function enqueueQuestions(questions: StackOverflowQuestion[]) {
  const seen = new Set(queue.map((question) => question.questionId));

  for (const question of questions) {
    if (usedQuestionIds.has(question.questionId)) continue;
    if (seen.has(question.questionId)) continue;
    queue.push(question);
    seen.add(question.questionId);
  }

  queue = shuffle(queue).slice(0, 200);
}

async function refillQueueIfNeeded() {
  if (!usedIdsLoaded) {
    usedQuestionIds = await getUsedQuestionIds();
    usedIdsLoaded = true;
  }

  if (queue.length >= PREFETCH_TARGET) return;

  // Try cached questions first
  const cached = await getCachedStackOverflowQuestions(500);
  enqueueQuestions(cached);
  if (queue.length >= PREFETCH_TARGET) return;

  if (!inFlightFetch) {
    inFlightFetch = fetchQuestions()
      .then(async (fresh) => {
        if (fresh.length > 0) {
          await upsertStackOverflowQuestions(fresh);
          enqueueQuestions(fresh);
        }

        // If queue is still empty after fetching, clear used IDs for this session
        // to allow replaying old questions rather than erroring out
        if (queue.length === 0 && fresh.length > 0) {
          logger("WARN", "stackexchange", "All fetched questions already used, replaying from cache");
          const replayable = fresh.filter((q) => q.title.length > 0);
          for (const q of replayable) {
            usedQuestionIds.delete(q.questionId);
          }
          enqueueQuestions(replayable);
        }

        return fresh;
      })
      .catch((error) => {
        logger("ERROR", "stackexchange", "Failed fetching Stack Overflow questions", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      })
      .finally(() => {
        inFlightFetch = null;
      });
  }

  await inFlightFetch;
}

export function setStackOverflowLogger(nextLogger: Logger) {
  logger = nextLogger;
}

export function setQuestionDifficulty(difficulty: QuestionDifficulty) {
  if (difficulty !== currentDifficulty) {
    currentDifficulty = difficulty;
    currentPage = 1;
    // Clear queue to fetch with new difficulty
    queue = [];
    logger("INFO", "stackexchange", "Question difficulty changed", { difficulty });
  }
}

export function getQuestionDifficulty(): QuestionDifficulty {
  return currentDifficulty;
}

export async function initStackOverflowPool() {
  if (initialized) return;
  initialized = true;
  await refillQueueIfNeeded();
}

export async function prefetchStackOverflowQuestions(target = PREFETCH_TARGET) {
  if (queue.length >= target) return;
  await refillQueueIfNeeded();
}

export async function nextStackOverflowQuestion(): Promise<StackOverflowQuestion> {
  if (!initialized) {
    await initStackOverflowPool();
  }

  // Try up to 3 times to get a question
  for (let attempt = 0; attempt < 3; attempt++) {
    if (queue.length === 0) {
      await refillQueueIfNeeded();
    }

    const question = queue.shift();
    if (question) {
      usedQuestionIds.add(question.questionId);
      void prefetchStackOverflowQuestions();
      return question;
    }

    // Wait a bit and try again with a new page
    if (attempt < 2) {
      currentPage += 1;
      if (currentPage > 25) currentPage = 1;
      await sleep(2000);
    }
  }

  throw new Error("No Stack Overflow questions available");
}

export async function resetStackOverflowPool() {
  queue = [];
  usedQuestionIds = await getUsedQuestionIds();
  usedIdsLoaded = true;
  inFlightFetch = null;
  initialized = false;
  currentPage = 1;
}
