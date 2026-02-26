import { Database } from "bun:sqlite";

const path = process.env.DATABASE_PATH ?? "bruh-help.sqlite";
const db = new Database(path);

const rows = db
  .query("SELECT id, num, language, question_id, winner FROM rounds ORDER BY id DESC LIMIT 20")
  .all();

console.table(rows);
