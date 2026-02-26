export type ModelRole = "battle" | "system" | "contestant" | "judge";

export type Model = {
  id: string;
  name: string;
  role: ModelRole;
  fallbackIds?: string[];
};

export type TaskInfo = {
  model: Model;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
};

export type VoteInfo = {
  voter: Model;
  startedAt: number;
  finishedAt?: number;
  votedFor?: Model;
  reasoning?: string;
  error?: boolean;
};

export type StackOverflowQuestion = {
  questionId: number;
  title: string;
  bodySnippet: string;
  link: string;
  tags: string[];
  language: string;
  creationDate: number;
};

export type RoundState = {
  num: number;
  phase: "prompting" | "answering" | "voting" | "done";
  prompter: Model;
  promptTask: TaskInfo;
  prompt?: string;
  question: StackOverflowQuestion;
  language: string;
  contestants: [Model, Model];
  answerTasks: [TaskInfo, TaskInfo];
  votes: VoteInfo[];
  scoreA?: number;
  scoreB?: number;
  viewerVotesA?: number;
  viewerVotesB?: number;
  viewerVotingEndsAt?: number;
  winningModel?: string | null;
  winningViewerModel?: string | null;
};

export type ModelScoreLine = {
  wins: number;
  rounds: number;
  viewerWins: number;
  judgeWins: number;
  judgeRounds: number;
};

export type LanguageScoreboard = Record<string, Record<string, ModelScoreLine>>;

export type GameState = {
  completed: RoundState[];
  active: RoundState | null;
  scores: Record<string, number>;
  viewerScores: Record<string, number>;
  judgeScores: Record<string, number>;
  judgeRounds: Record<string, number>;
  languageScores: LanguageScoreboard;
  done: boolean;
  isPaused: boolean;
  generation: number;
};
