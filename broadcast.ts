import type { LanguageScoreboard, Model, RoundState } from "./types.ts";
import { MODEL_LOGO_CDN_HOSTNAME } from "./utils.ts";

type ClientGameState = {
  lastCompleted: RoundState | null;
  active: RoundState | null;
  scores: Record<string, number>;
  viewerScores: Record<string, number>;
  languageScores: LanguageScoreboard;
  done: boolean;
  isPaused: boolean;
  generation: number;
};

type StateMessage = {
  type: "state";
  data: ClientGameState;
  totalRounds: number;
  viewerCount: number;
  version?: string;
};

type ViewerCountMessage = {
  type: "viewerCount";
  viewerCount: number;
};

type ServerMessage = StateMessage | ViewerCountMessage;

const WIDTH = 1920;
const HEIGHT = 1080;

const COLORS: Record<string, string> = {
  "Llama 3.1 8B": "#f59e0b",
  "Gemma 2 9B": "#D97757",
  "Qwen 32B Judge": "#38bdf8",
  "Llama 3.3 70B Judge": "#a78bfa",
  "Phi-4": "#e879f9",
  "Stack Overflow": "#f97316",
};

const canvas = document.getElementById("broadcast-canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("broadcast-status") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;

let state: ClientGameState | null = null;
let totalRounds: number | null = null;
let viewerCount = 0;
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let knownVersion: string | null = null;

function colorFor(name: string) {
  return COLORS[name] ?? "#a1a1aa";
}

function logoFor(name: string): string | null {
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

const logoCache: Record<string, HTMLImageElement> = {};
function drawLogo(name: string, x: number, y: number, size: number): boolean {
  const url = logoFor(name);
  if (!url) return false;

  if (!logoCache[url]) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    logoCache[url] = img;
  }

  const img = logoCache[url];
  if (img.complete && img.naturalHeight > 0) {
    ctx.drawImage(img, x, y, size, size);
    return true;
  }

  return false;
}

function setStatus(value: string) {
  statusEl.textContent = value;
}

function textLines(text: string, maxWidth: number, font: string, maxLines = 3) {
  ctx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      if (lines.length === maxLines) break;
    }

    current = word;
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length === maxLines && words.length > lines.join(" ").split(" ").length) {
    let last = lines[maxLines - 1] ?? "";
    while (last.length > 1 && ctx.measureText(`${last}...`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}...`;
  }

  return lines;
}

function drawTextBlock(
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  font: string,
  color: string,
  maxLines: number,
) {
  const lines = textLines(text, maxWidth, font, maxLines);
  ctx.font = font;
  ctx.fillStyle = color;
  lines.forEach((line, idx) => {
    ctx.fillText(line, x, y + idx * lineHeight);
  });
}

function roundRect(x: number, y: number, w: number, h: number, r: number, fill: string) {
  const p = new Path2D();
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.quadraticCurveTo(x + w, y, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.quadraticCurveTo(x, y + h, x, y + h - r);
  p.lineTo(x, y + r);
  p.quadraticCurveTo(x, y, x + r, y);
  ctx.fillStyle = fill;
  ctx.fill(p);
}

function setupWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus("WS connected");
  };

  ws.onclose = () => {
    setStatus("WS reconnecting...");
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
    reconnectTimer = window.setTimeout(setupWebSocket, 1000);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      if (msg.type === "state") {
        if (msg.version) {
          if (!knownVersion) {
            knownVersion = msg.version;
          } else if (knownVersion !== msg.version) {
            location.reload();
            return;
          }
        }

        state = msg.data;
        totalRounds = Number.isFinite(msg.totalRounds) ? msg.totalRounds : null;
        viewerCount = msg.viewerCount;
      } else {
        viewerCount = msg.viewerCount;
      }
    } catch {
      // Ignore malformed payloads.
    }
  };
}

function drawHeader() {
  ctx.fillStyle = "#080808";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = "#f97316";
  ctx.font = '700 52px "Bebas Neue", sans-serif';
  ctx.fillText("bruh.help", 52, 74);

  ctx.fillStyle = "#71717a";
  ctx.font = '600 20px "IBM Plex Mono", monospace';
  ctx.fillText("Live AI battles for dev errors & logs", 52, 102);

  ctx.fillStyle = "#3f3f46";
  ctx.fillText(`${viewerCount} viewers`, WIDTH - 250, 60);
}

function drawScoreboard(scores: Record<string, number>, viewerScores: Record<string, number>) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const viewerEntries = Object.entries(viewerScores).sort((a, b) => b[1] - a[1]);

  roundRect(WIDTH - 380, 0, 380, HEIGHT, 0, "#0b0b0b");
  ctx.fillStyle = "#1f1f23";
  ctx.fillRect(WIDTH - 380, 0, 1, HEIGHT);

  ctx.fillStyle = "#d4d4d8";
  ctx.font = '700 18px "IBM Plex Mono", monospace';
  ctx.fillText("STANDINGS", WIDTH - 344, 74);

  drawScoreboardSection(entries as [string, number][], "AI", 110);
  drawScoreboardSection(viewerEntries as [string, number][], "VIEWERS", 390);
}

function drawScoreboardSection(entries: [string, number][], label: string, startY: number) {
  const max = entries[0]?.[1] || 1;

  ctx.fillStyle = "#52525b";
  ctx.font = '700 12px "IBM Plex Mono", monospace';
  ctx.fillText(label, WIDTH - 344, startY);

  entries.forEach(([name, score], idx) => {
    const y = startY + 20 + idx * 56;
    const pct = max > 0 ? score / max : 0;

    const logo = drawLogo(name, WIDTH - 318, y + 2, 18);

    ctx.fillStyle = colorFor(name);
    ctx.font = '600 18px "Space Grotesk", sans-serif';
    ctx.fillText(
      name.length > 18 ? `${name.slice(0, 18)}...` : name,
      logo ? WIDTH - 294 : WIDTH - 318,
      y + 16,
    );

    roundRect(WIDTH - 318, y + 28, 230, 4, 2, "#27272a");
    if (pct > 0) {
      roundRect(WIDTH - 318, y + 28, Math.max(8, 230 * pct), 4, 2, colorFor(name));
    }

    ctx.fillStyle = "#a1a1aa";
    ctx.font = '700 16px "IBM Plex Mono", monospace';
    const scoreText = String(score);
    const width = ctx.measureText(scoreText).width;
    ctx.fillText(scoreText, WIDTH - 48 - width, y + 16);
  });
}

function drawRound(round: RoundState) {
  const mainW = WIDTH - 380;

  ctx.fillStyle = "#d4d4d8";
  ctx.font = '700 22px "IBM Plex Mono", monospace';
  const total = totalRounds && Number.isFinite(totalRounds) ? `/${totalRounds}` : "";
  ctx.fillText(`Round ${round.num}${total}`, 56, 152);

  const phaseLabel =
    round.phase === "prompting"
      ? "FETCHING"
      : round.phase === "answering"
      ? "ANSWERING"
      : round.phase === "voting"
      ? "VOTING"
      : "DONE";

  ctx.fillStyle = "#a1a1aa";
  const pw = ctx.measureText(phaseLabel).width;
  ctx.fillText(phaseLabel, mainW - 64 - pw, 152);

  if (round.phase === "voting" && round.viewerVotingEndsAt) {
    const left = Math.max(0, Math.ceil((round.viewerVotingEndsAt - Date.now()) / 1000));
    if (left > 0) {
      const txt = `${left}s`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = "#22c55e";
      ctx.fillText(txt, mainW - 76 - pw - tw, 152);
    }
  }

  ctx.fillStyle = "#71717a";
  ctx.font = '600 15px "IBM Plex Mono", monospace';
  ctx.fillText(`Source: Stack Overflow #${round.question.questionId} (${round.language})`, 56, 196);

  ctx.fillStyle = "#f4f4f5";
  ctx.font = '400 56px "Bebas Neue", sans-serif';
  drawTextBlock(round.question.title, 56, 256, mainW - 112, 54, '400 56px "Bebas Neue", sans-serif', "#f4f4f5", 3);

  ctx.fillStyle = "#a1a1aa";
  ctx.font = '400 24px "Space Grotesk", sans-serif';
  drawTextBlock(round.question.bodySnippet, 56, 440, mainW - 112, 30, '400 24px "Space Grotesk", sans-serif', "#a1a1aa", 4);

  if (round.phase !== "prompting") {
    const cardW = (mainW - 56 * 2 - 24) / 2;
    const cardY = 580;
    const cardH = HEIGHT - cardY - 34;

    drawContestant(round, 0, 56, cardY, cardW, cardH);
    drawContestant(round, 1, 56 + cardW + 24, cardY, cardW, cardH);
  }
}

function drawContestant(round: RoundState, index: 0 | 1, x: number, y: number, w: number, h: number) {
  const task = round.answerTasks[index];
  const [a, b] = round.contestants;

  let votesA = 0;
  let votesB = 0;
  for (const vote of round.votes) {
    if (vote.votedFor?.name === a.name) votesA += 1;
    if (vote.votedFor?.name === b.name) votesB += 1;
  }

  const modelVotes = index === 0 ? votesA : votesB;
  const otherVotes = index === 0 ? votesB : votesA;
  const totalVotes = votesA + votesB;
  const pct = totalVotes > 0 ? modelVotes / totalVotes : 0;

  const viewerVotes = index === 0 ? round.viewerVotesA ?? 0 : round.viewerVotesB ?? 0;
  const totalViewerVotes = (round.viewerVotesA ?? 0) + (round.viewerVotesB ?? 0);
  const viewerPct = totalViewerVotes > 0 ? viewerVotes / totalViewerVotes : 0;

  const isWinner = round.phase === "done" && modelVotes > otherVotes;

  roundRect(x, y, w, h, 12, isWinner ? "rgba(217,119,87,0.14)" : "rgba(10,10,10,0.8)");
  roundRect(x, y, 4, h, 0, colorFor(task.model.name));

  const logoDrawn = drawLogo(task.model.name, x + 18, y + 16, 24);
  ctx.fillStyle = colorFor(task.model.name);
  ctx.font = '700 30px "Space Grotesk", sans-serif';
  ctx.fillText(task.model.name, logoDrawn ? x + 48 : x + 18, y + 37);

  if (isWinner) {
    roundRect(x + w - 86, y + 14, 68, 28, 6, "#f97316");
    ctx.fillStyle = "#09090b";
    ctx.font = '700 15px "IBM Plex Mono", monospace';
    ctx.fillText("WIN", x + w - 62, y + 33);
  }

  const answer = task.result
    ? task.result
    : task.error
    ? task.error
    : "Generating fix...";

  drawTextBlock(
    answer,
    x + 18,
    y + 86,
    w - 36,
    27,
    '400 20px "Space Grotesk", sans-serif',
    task.result ? "#f4f4f5" : "#71717a",
    7,
  );

  if (round.phase === "voting" || round.phase === "done") {
    roundRect(x + 18, y + h - 86, w - 36, 4, 2, "#27272a");
    if (pct > 0) {
      roundRect(x + 18, y + h - 86, Math.max(8, (w - 36) * pct), 4, 2, colorFor(task.model.name));
    }

    ctx.fillStyle = colorFor(task.model.name);
    ctx.font = '700 20px "IBM Plex Mono", monospace';
    ctx.fillText(String(modelVotes), x + 18, y + h - 58);

    ctx.fillStyle = "#71717a";
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText("judge votes", x + 52, y + h - 58);

    roundRect(x + 18, y + h - 38, w - 36, 4, 2, "#27272a");
    if (viewerPct > 0) {
      roundRect(x + 18, y + h - 38, Math.max(8, (w - 36) * viewerPct), 4, 2, "#71717a");
    }

    ctx.fillStyle = "#a1a1aa";
    ctx.font = '700 16px "IBM Plex Mono", monospace';
    ctx.fillText(String(viewerVotes), x + 18, y + h - 14);
    ctx.font = '600 12px "IBM Plex Mono", monospace';
    ctx.fillText("viewer votes", x + 44, y + h - 14);
  }
}

function drawWaiting() {
  const mainW = WIDTH - 380;
  const text = "Waiting for game state...";
  ctx.fillStyle = "#71717a";
  ctx.font = '500 44px "Bebas Neue", sans-serif';
  const tw = ctx.measureText(text).width;
  ctx.fillText(text, (mainW - tw) / 2, HEIGHT / 2);
}

function drawDone(scores: Record<string, number>) {
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!winner) return;

  const [name] = winner;
  const mainW = WIDTH - 380;

  ctx.fillStyle = "#3f3f46";
  ctx.font = '700 22px "IBM Plex Mono", monospace';
  const go = "GAME OVER";
  const goW = ctx.measureText(go).width;
  ctx.fillText(go, (mainW - goW) / 2, HEIGHT / 2 - 80);

  ctx.fillStyle = colorFor(name);
  ctx.font = '700 86px "Bebas Neue", sans-serif';
  const nw = ctx.measureText(name).width;
  ctx.fillText(name, (mainW - nw) / 2, HEIGHT / 2);

  ctx.fillStyle = "#a1a1aa";
  ctx.font = '600 26px "Space Grotesk", sans-serif';
  const sub = "won this round";
  const sw = ctx.measureText(sub).width;
  ctx.fillText(sub, (mainW - sw) / 2, HEIGHT / 2 + 52);
}

function draw() {
  drawHeader();

  if (!state) {
    drawWaiting();
    return;
  }

  drawScoreboard(state.scores, state.viewerScores);

  const isNextPrompting = state.active?.phase === "prompting" && !state.active.prompt;
  const displayRound = isNextPrompting && state.lastCompleted ? state.lastCompleted : state.active ?? state.lastCompleted;

  if (state.done) {
    drawDone(state.scores);
  } else if (displayRound) {
    drawRound(displayRound);
  } else {
    drawWaiting();
  }
}

function renderLoop() {
  draw();
  requestAnimationFrame(renderLoop);
}

function startCanvasCaptureSink() {
  const params = new URLSearchParams(window.location.search);
  const sink = params.get("sink");
  if (!sink) return;

  if (!("MediaRecorder" in window)) {
    setStatus("MediaRecorder unavailable");
    return;
  }

  const fps = Number.parseInt(params.get("captureFps") ?? "30", 10);
  const bitrate = Number.parseInt(params.get("captureBitrate") ?? "12000000", 10);
  const stream = canvas.captureStream(Number.isFinite(fps) && fps > 0 ? fps : 30);
  const socket = new WebSocket(sink);
  socket.binaryType = "arraybuffer";

  let recorder: MediaRecorder | null = null;
  const mimeCandidates = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];
  const mimeType = mimeCandidates.find((value) => MediaRecorder.isTypeSupported(value)) ?? "";

  socket.onopen = () => {
    const options: MediaRecorderOptions = {
      videoBitsPerSecond: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 12_000_000,
    };
    if (mimeType) options.mimeType = mimeType;

    recorder = new MediaRecorder(stream, options);
    recorder.ondataavailable = async (event) => {
      if (event.data.size === 0) return;
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 16_000_000) return;
      const chunk = await event.data.arrayBuffer();
      socket.send(chunk);
    };
    recorder.onerror = () => {
      setStatus("Recorder error");
    };
    recorder.start(250);
    setStatus(`capture->ws ${fps}fps`);
  };

  socket.onclose = () => {
    recorder?.stop();
    setStatus("capture sink closed");
  };
}

setupWebSocket();
startCanvasCaptureSink();
renderLoop();
