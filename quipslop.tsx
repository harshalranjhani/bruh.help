import { useEffect, useRef, useState } from "react";
import { Box, Text, Static, render } from "ink";
import {
  CONTESTANT_MODELS,
  LOG_FILE,
  createBlankScores,
  createEmptyLanguageScores,
  runGame,
} from "./game.ts";
import type { GameState, RoundState } from "./types.ts";

function RoundLine({ round }: { round: RoundState }) {
  const a = round.contestants[0];
  const b = round.contestants[1];
  const votesA = round.scoreA ? Math.floor(round.scoreA / 100) : 0;
  const votesB = round.scoreB ? Math.floor(round.scoreB / 100) : 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{`Round ${round.num} (${round.language})`}</Text>
      <Text>{round.question.title}</Text>
      <Text>{`${a.name}: ${votesA} | ${b.name}: ${votesB}`}</Text>
      <Text dimColor>{`Winner: ${round.winningModel ?? "tie"}`}</Text>
    </Box>
  );
}

function App({ runs }: { runs: number }) {
  const stateRef = useRef<GameState>({
    completed: [],
    active: null,
    scores: createBlankScores(),
    viewerScores: createBlankScores(),
    languageScores: createEmptyLanguageScores(),
    done: false,
    isPaused: false,
    generation: 0,
  });
  const [, setTick] = useState(0);

  useEffect(() => {
    runGame(runs, stateRef.current, () => setTick((v) => v + 1)).then(() => {
      setTimeout(() => process.exit(0), 100);
    });
  }, [runs]);

  const state = stateRef.current;

  return (
    <Box flexDirection="column">
      <Text bold>{`bruh.help CLI (${runs === Infinity ? "infinite" : runs} rounds)`}</Text>
      <Text dimColor>{`Contestants: ${CONTESTANT_MODELS.map((m) => m.name).join(", ")}`}</Text>

      <Static items={state.completed}>
        {(round: RoundState) => <RoundLine key={round.num} round={round} />}
      </Static>

      {state.active && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{`Active round ${state.active.num}: ${state.active.phase}`}</Text>
          <Text dimColor>{state.active.question.title}</Text>
        </Box>
      )}

      {state.done && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Final score</Text>
          {Object.entries(state.scores)
            .sort((a, b) => b[1] - a[1])
            .map(([name, score]) => (
              <Text key={name}>{`${name}: ${score}`}</Text>
            ))}
          <Text dimColor>{`Log file: ${LOG_FILE}`}</Text>
        </Box>
      )}
    </Box>
  );
}

const runsArg = process.argv.find((arg) => arg.startsWith("runs="));
const runsRaw = runsArg ? runsArg.split("=")[1] : "infinite";
const runs = runsRaw === "infinite" ? Infinity : Number.parseInt(runsRaw ?? "", 10);

render(<App runs={runs} />);
