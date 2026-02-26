import { Database } from "bun:sqlite";
import type { RoundState, StackOverflowQuestion } from "./types.ts";

const dbPath = process.env.DATABASE_PATH ?? "bruh-help.sqlite";
export const db = new Database(dbPath, { create: true });

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    language TEXT NOT NULL,
    question_id INTEGER NOT NULL,
    contestant_a TEXT NOT NULL,
    contestant_b TEXT NOT NULL,
    winner TEXT,
    viewer_winner TEXT,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS rounds_num_idx ON rounds(num DESC);
  CREATE INDEX IF NOT EXISTS rounds_lang_idx ON rounds(language);
  CREATE INDEX IF NOT EXISTS rounds_qid_idx ON rounds(question_id);

  CREATE TABLE IF NOT EXISTS so_questions (
    question_id INTEGER PRIMARY KEY,
    creation_date INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    title TEXT NOT NULL,
    body_snippet TEXT NOT NULL,
    link TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    language TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS so_questions_creation_idx ON so_questions(creation_date DESC);
  CREATE INDEX IF NOT EXISTS so_questions_fetched_idx ON so_questions(fetched_at DESC);
`);

function parseRound(data: string): RoundState {
  return JSON.parse(data) as RoundState;
}

export function saveRound(round: RoundState) {
  const insert = db.prepare(`
    INSERT INTO rounds (
      num,
      language,
      question_id,
      contestant_a,
      contestant_b,
      winner,
      viewer_winner,
      data
    ) VALUES (
      $num,
      $language,
      $question_id,
      $contestant_a,
      $contestant_b,
      $winner,
      $viewer_winner,
      $data
    )
  `);

  insert.run({
    $num: round.num,
    $language: round.language,
    $question_id: round.question.questionId,
    $contestant_a: round.contestants[0].name,
    $contestant_b: round.contestants[1].name,
    $winner: round.winningModel ?? null,
    $viewer_winner: round.winningViewerModel ?? null,
    $data: JSON.stringify(round),
  });
}

export function getRounds(page = 1, limit = 10, language?: string) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const offset = (safePage - 1) * safeLimit;

  const countQuery = language
    ? db
        .query("SELECT COUNT(*) AS count FROM rounds WHERE language = $language")
        .get({ $language: language })
    : db.query("SELECT COUNT(*) AS count FROM rounds").get();

  const rows = language
    ? db
        .query(
          `SELECT data FROM rounds
           WHERE language = $language
           ORDER BY num DESC, id DESC
           LIMIT $limit OFFSET $offset`,
        )
        .all({ $language: language, $limit: safeLimit, $offset: offset })
    : db
        .query(
          `SELECT data FROM rounds
           ORDER BY num DESC, id DESC
           LIMIT $limit OFFSET $offset`,
        )
        .all({ $limit: safeLimit, $offset: offset });

  const total = Number((countQuery as { count?: number } | null)?.count ?? 0);
  return {
    rounds: (rows as { data: string }[]).map((row) => parseRound(row.data)),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

export function getAllRounds() {
  const rows = db
    .query("SELECT data FROM rounds ORDER BY num ASC, id ASC")
    .all() as { data: string }[];
  return rows.map((row) => parseRound(row.data));
}

export function countRounds(): number {
  const row = db.query("SELECT COUNT(*) AS count FROM rounds").get() as
    | { count?: number }
    | null;
  return Number(row?.count ?? 0);
}

export function clearAllRounds() {
  db.exec("DELETE FROM rounds;");
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'rounds';");
}

export function upsertStackOverflowQuestions(questions: StackOverflowQuestion[]) {
  if (questions.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO so_questions (
      question_id,
      creation_date,
      fetched_at,
      title,
      body_snippet,
      link,
      tags_json,
      language
    ) VALUES (
      $question_id,
      $creation_date,
      $fetched_at,
      $title,
      $body_snippet,
      $link,
      $tags_json,
      $language
    )
    ON CONFLICT(question_id) DO UPDATE SET
      creation_date = excluded.creation_date,
      fetched_at = excluded.fetched_at,
      title = excluded.title,
      body_snippet = excluded.body_snippet,
      link = excluded.link,
      tags_json = excluded.tags_json,
      language = excluded.language
  `);

  const txn = db.transaction((rows: StackOverflowQuestion[]) => {
    const fetchedAt = Date.now();
    for (const q of rows) {
      insert.run({
        $question_id: q.questionId,
        $creation_date: q.creationDate,
        $fetched_at: fetchedAt,
        $title: q.title,
        $body_snippet: q.bodySnippet,
        $link: q.link,
        $tags_json: JSON.stringify(q.tags),
        $language: q.language,
      });
    }
  });

  txn(questions);
}

export function getCachedStackOverflowQuestions(limit = 100): StackOverflowQuestion[] {
  const rows = db
    .query(
      `SELECT
        question_id,
        creation_date,
        title,
        body_snippet,
        link,
        tags_json,
        language
      FROM so_questions
      ORDER BY creation_date DESC
      LIMIT $limit`,
    )
    .all({ $limit: Math.max(1, limit) }) as {
    question_id: number;
    creation_date: number;
    title: string;
    body_snippet: string;
    link: string;
    tags_json: string;
    language: string;
  }[];

  return rows.map((row) => ({
    questionId: row.question_id,
    creationDate: row.creation_date,
    title: row.title,
    bodySnippet: row.body_snippet,
    link: row.link,
    tags: JSON.parse(row.tags_json) as string[],
    language: row.language,
  }));
}

export function getUsedQuestionIds(): Set<number> {
  const rows = db
    .query("SELECT DISTINCT question_id FROM rounds")
    .all() as { question_id: number }[];
  return new Set(rows.map((row) => row.question_id));
}
