import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGenerateAnswer, callVote, CONTESTANT_MODELS, JUDGE_MODELS, withRetry } from "./game.ts";
import { nextStackOverflowQuestion } from "./stackoverflow.ts";
import { shuffle } from "./utils.ts";

const TOTAL_ROUNDS = Number.parseInt(process.env.BULK_TEST_ROUNDS ?? "25", 10);
const LOGS_DIR = join(import.meta.dir, "logs");
mkdirSync(LOGS_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = join(LOGS_DIR, `bulk-test-${timestamp}.log`);

function logLine(message: string) {
  appendFileSync(LOG_FILE, `${message}\n`);
}

async function runRound(roundNum: number) {
  const question = await nextStackOverflowQuestion();
  const [a, b] = shuffle([...CONTESTANT_MODELS]);
  const answerA = await withRetry(
    () => callGenerateAnswer(a, question),
    (text) => text.length > 20,
    2,
    `bulk:${roundNum}:answer:${a.name}`,
  );
  const answerB = await withRetry(
    () => callGenerateAnswer(b, question),
    (text) => text.length > 20,
    2,
    `bulk:${roundNum}:answer:${b.name}`,
  );

  let votesA = 0;
  let votesB = 0;
  for (const judge of JUDGE_MODELS) {
    const showAFirst = Math.random() > 0.5;
    const first = showAFirst ? answerA : answerB;
    const second = showAFirst ? answerB : answerA;
    const result = await withRetry(
      () => callVote(judge, question, first, second),
      (vote) => vote.vote === "A" || vote.vote === "B",
      2,
      `bulk:${roundNum}:vote:${judge.name}`,
    );
    const voteForA = showAFirst ? result.vote === "A" : result.vote === "B";
    if (voteForA) votesA += 1;
    else votesB += 1;
  }

  logLine(`\n=== ROUND ${roundNum} ===`);
  logLine(`Question: ${question.title}`);
  logLine(`A (${a.name}): ${answerA}`);
  logLine(`B (${b.name}): ${answerB}`);
  logLine(`Votes -> A:${votesA} B:${votesB}`);
  logLine(`Winner -> ${votesA === votesB ? "TIE" : votesA > votesB ? a.name : b.name}`);
}

async function main() {
  logLine(`Bulk test started: ${new Date().toISOString()}`);
  for (let i = 1; i <= TOTAL_ROUNDS; i++) {
    try {
      await runRound(i);
      process.stdout.write(`\rCompleted ${i}/${TOTAL_ROUNDS}`);
    } catch (error) {
      logLine(`Round ${i} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.stdout.write("\n");
  console.log(`Done. Log file: ${LOG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
