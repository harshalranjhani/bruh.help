import type { StackOverflowQuestion } from "./types.ts";

export function buildFixSystemPrompt(): string {
  return [
    "You are a senior software engineer reviewing a real Stack Overflow question.",
    "Produce a direct, technically correct, easy-to-read fix.",
    "Response format:",
    "1) Root cause",
    "2) Fix steps",
    "3) Corrected code snippet",
    "4) Validation checklist",
    "Use plain technical language. No slang, jokes, or insults.",
    "Do not invent package APIs. If unsure, say what to verify.",
  ].join("\n");
}

export function buildFixPrompt(question: StackOverflowQuestion): string {
  return [
    `Stack Overflow Title: ${question.title}`,
    `Tags: ${question.tags.join(", ")}`,
    `Language: ${question.language}`,
    `Body snippet: ${question.bodySnippet}`,
    `Question URL: ${question.link}`,
    "Provide the best direct fix for this issue.",
  ].join("\n\n");
}

export function buildJudgeSystemPrompt(): string {
  return [
    "You are a strict technical judge in a live AI coding battle.",
    "Pick the better fix for correctness, safety, and clarity.",
    "Reply as strict JSON only: {\"vote\":\"A\"|\"B\",\"reason\":\"...\"}",
    "Reason must be under 180 characters.",
    "No markdown, no extra fields.",
  ].join("\n");
}

export function buildJudgePrompt(
  question: StackOverflowQuestion,
  answerA: string,
  answerB: string,
): string {
  return [
    `Question: ${question.title}`,
    `Body: ${question.bodySnippet}`,
    `Tags: ${question.tags.join(", ")}`,
    "",
    `Answer A:\n${answerA}`,
    "",
    `Answer B:\n${answerB}`,
    "",
    "Which answer is better? Reply using strict JSON.",
  ].join("\n");
}
