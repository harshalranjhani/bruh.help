import PocketBase from "pocketbase";
import type { RoundState, StackOverflowQuestion } from "./types.ts";

// ── PocketBase client ──

const pbUrl = process.env.POCKETBASE_URL?.trim();
const pbEmail = process.env.POCKETBASE_EMAIL?.trim();
const pbPassword = process.env.POCKETBASE_PASSWORD?.trim();

if (!pbUrl) throw new Error("Missing POCKETBASE_URL env variable");
if (!pbEmail) throw new Error("Missing POCKETBASE_EMAIL env variable");
if (!pbPassword) throw new Error("Missing POCKETBASE_PASSWORD env variable");

export const pb = new PocketBase(pbUrl);

let authReady: Promise<void> | null = null;

async function tryAuth(): Promise<void> {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;
  while (true) {
    try {
      await pb.collection("_superusers").authWithPassword(pbEmail!, pbPassword!);
      console.log("[PocketBase] Authenticated successfully");
      return;
    } catch (err: unknown) {
      attempt++;
      const status = (err as { status?: number })?.status;
      const backoff = Math.min(5_000 * attempt, 60_000);
      console.error(
        `[PocketBase] Auth failed (attempt ${attempt}, status ${status ?? "?"}). Retrying in ${backoff / 1000}s…`,
        (err as Error)?.message ?? err,
      );
      await delay(backoff);
    }
  }
}

export function initDb(): Promise<void> {
  if (!authReady) {
    authReady = tryAuth();
  }
  return authReady;
}

// Auto-init on import (non-blocking — server starts regardless)
initDb();

// ── Helpers ──

function parseRound(data: unknown): RoundState {
  if (typeof data === "string") return JSON.parse(data) as RoundState;
  return data as RoundState;
}

// ── Rounds ──

export async function saveRound(round: RoundState) {
  await initDb();
  const payload = {
    num: round.num,
    language: round.language,
    question_id: round.question.questionId,
    contestant_a: round.contestants[0]?.name ?? "",
    contestant_b: round.contestants[1]?.name ?? "",
    winner: round.winningModel ?? "",
    viewer_winner: round.winningViewerModel ?? "",
    data: round,
  };
  console.log("[PocketBase] saveRound payload:", JSON.stringify({
    num: payload.num,
    contestant_a: payload.contestant_a,
    contestant_b: payload.contestant_b,
    winner: payload.winner,
  }));
  const created = await pb.collection("rounds").create(payload);
  console.log("[PocketBase] created record fields:", JSON.stringify({
    id: created.id,
    contestant_a: created["contestant_a"],
    contestant_b: created["contestant_b"],
    winner: created["winner"],
    // List all keys PocketBase stored
    allKeys: Object.keys(created),
  }));
}

export async function getRounds(page = 1, limit = 10, language?: string) {
  await initDb();
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);

  const filter = language ? `language = "${language}"` : "";

  const result = await pb.collection("rounds").getList(safePage, safeLimit, {
    sort: "-num,-created",
    filter,
  });

  return {
    rounds: result.items.map((item) => parseRound(item.data)),
    total: result.totalItems,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, result.totalPages),
  };
}

export async function getAllRounds(): Promise<RoundState[]> {
  await initDb();
  const records = await pb.collection("rounds").getFullList({
    sort: "num,created",
  });
  return records.map((item) => parseRound(item.data));
}

export async function countRounds(): Promise<number> {
  await initDb();
  const result = await pb.collection("rounds").getList(1, 1);
  return result.totalItems;
}

export async function clearAllRounds() {
  await initDb();
  // PocketBase doesn't have bulk delete — fetch all IDs and delete
  const records = await pb.collection("rounds").getFullList({
    fields: "id",
  });
  for (const record of records) {
    await pb.collection("rounds").delete(record.id);
  }
}

// ── Stack Overflow questions ──

export async function upsertStackOverflowQuestions(questions: StackOverflowQuestion[]) {
  if (questions.length === 0) return;
  await initDb();

  const fetchedAt = Date.now();

  for (const q of questions) {
    const payload = {
      question_id: q.questionId,
      creation_date: q.creationDate,
      fetched_at: fetchedAt,
      title: q.title,
      body_snippet: q.bodySnippet,
      link: q.link,
      tags_json: JSON.stringify(q.tags),
      language: q.language,
    };

    try {
      // Try to find existing record by question_id
      const existing = await pb.collection("so_questions").getFirstListItem(
        `question_id = ${q.questionId}`,
      );
      // Update existing
      await pb.collection("so_questions").update(existing.id, payload);
    } catch {
      // Not found — create new
      try {
        await pb.collection("so_questions").create(payload);
      } catch (createErr) {
        // Might be a race condition duplicate, ignore
        console.warn("[PocketBase] Failed to upsert SO question:", q.questionId, createErr);
      }
    }
  }
}

export async function getCachedStackOverflowQuestions(limit = 100): Promise<StackOverflowQuestion[]> {
  await initDb();

  const result = await pb.collection("so_questions").getList(1, Math.max(1, limit), {
    sort: "-creation_date",
  });

  return result.items.map((row) => ({
    questionId: row.question_id as number,
    creationDate: row.creation_date as number,
    title: row.title as string,
    bodySnippet: row.body_snippet as string,
    link: row.link as string,
    tags: JSON.parse(row.tags_json as string) as string[],
    language: row.language as string,
  }));
}

export async function getUsedQuestionIds(): Promise<Set<number>> {
  await initDb();

  const records = await pb.collection("rounds").getFullList({
    fields: "question_id",
  });

  return new Set(records.map((r) => r.question_id as number));
}
