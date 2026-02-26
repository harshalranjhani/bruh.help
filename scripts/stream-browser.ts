import puppeteer from "puppeteer";

type Mode = "live" | "dryrun";

type SinkWriter = {
  write(chunk: Uint8Array): number;
  end(error?: Error): number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function usage(): never {
  console.error("Usage: bun scripts/stream-browser.ts <live|dryrun>");
  console.error("Required for live mode: STREAM_RTMP_URL");
  process.exit(1);
}

function resolveMode(value: string | undefined): Mode {
  if (value === "live" || value === "dryrun") return value;
  return usage();
}

const mode = resolveMode(process.argv[2]);

const streamFps = parsePositiveInt(process.env.STREAM_FPS, 30);
const captureBitrate = parsePositiveInt(process.env.STREAM_CAPTURE_BITRATE, 12_000_000);
const targetSize = process.env.STREAM_TARGET_SIZE ?? "1920x1080";
const [targetWidth = "1920", targetHeight = "1080"] = targetSize.split("x");
const videoBitrate = process.env.STREAM_VIDEO_BITRATE ?? "6000k";
const maxrate = process.env.STREAM_MAXRATE ?? "6000k";
const bufsize = process.env.STREAM_BUFSIZE ?? "12000k";
const gop = String(parsePositiveInt(process.env.STREAM_GOP, 60));
const audioBitrate = process.env.STREAM_AUDIO_BITRATE ?? "160k";
const streamRtmpUrl = process.env.STREAM_RTMP_URL;
const serverPort = process.env.STREAM_APP_PORT ?? "5109";
const broadcastUrl = process.env.BROADCAST_URL ?? `http://127.0.0.1:${serverPort}/broadcast`;

if (mode === "live" && !streamRtmpUrl) {
  console.error("STREAM_RTMP_URL is not set.");
  process.exit(1);
}

async function assertBroadcastReachable(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function buildFfmpegArgs(currentMode: Mode): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "+genpts",
    "-f",
    "webm",
    "-i",
    "pipe:0",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    videoBitrate,
    "-maxrate",
    maxrate,
    "-bufsize",
    bufsize,
    "-g",
    gop,
    "-keyint_min",
    gop,
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-ar",
    "44100",
    "-ac",
    "2",
  ];

  if (currentMode === "live") {
    args.push("-f", "flv", streamRtmpUrl!);
    return args;
  }

  args.push("-f", "mpegts", "pipe:1");
  return args;
}

async function pipeReadableToSink(readable: ReadableStream<Uint8Array>, sink: SinkWriter) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink.write(value);
    }
  } finally {
    sink.end();
  }
}

async function main() {
  await assertBroadcastReachable(broadcastUrl);

  const ffmpegArgs = buildFfmpegArgs(mode);
  const ffmpeg = Bun.spawn(["ffmpeg", ...ffmpegArgs], {
    stdin: "pipe",
    stdout: mode === "dryrun" ? "pipe" : "inherit",
    stderr: "inherit",
  });

  let ffplay: Bun.Subprocess | null = null;
  let ffplayPump: Promise<void> | null = null;
  if (mode === "dryrun") {
    ffplay = Bun.spawn(
      ["ffplay", "-hide_banner", "-fflags", "nobuffer", "-flags", "low_delay", "-framedrop", "-i", "pipe:0"],
      {
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const stdout = ffmpeg.stdout;
    if (!stdout || !ffplay.stdin || typeof ffplay.stdin === "number") {
      throw new Error("Failed to pipe ffmpeg output into ffplay.");
    }
    ffplayPump = pipeReadableToSink(stdout, ffplay.stdin as SinkWriter);
  }

  let firstChunkResolve: (() => void) | null = null;
  let firstChunkReject: ((error: Error) => void) | null = null;
  const firstChunk = new Promise<void>((resolve, reject) => {
    firstChunkResolve = resolve;
    firstChunkReject = reject;
  });

  let shutdown: (() => Promise<void>) | null = null;

  const chunkServer = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/chunks" && server.upgrade(req)) {
        return;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(_ws, message) {
        if (!ffmpeg.stdin || typeof ffmpeg.stdin === "number") return;
        if (typeof message === "string") return;

        const chunk = message instanceof ArrayBuffer
          ? new Uint8Array(message)
          : ArrayBuffer.isView(message)
          ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
          : null;

        if (!chunk) return;

        try {
          ffmpeg.stdin.write(chunk);
          firstChunkResolve?.();
          firstChunkResolve = null;
          firstChunkReject = null;
        } catch (error) {
          const detail = error instanceof Error ? error : new Error(String(error));
          firstChunkReject?.(detail);
          firstChunkResolve = null;
          firstChunkReject = null;
          void shutdown?.();
        }
      },
    },
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

  const captureUrl = new URL(broadcastUrl);
  captureUrl.searchParams.set("sink", `ws://127.0.0.1:${chunkServer.port}/chunks`);
  captureUrl.searchParams.set("captureFps", String(streamFps));
  captureUrl.searchParams.set("captureBitrate", String(captureBitrate));

  await page.goto(captureUrl.toString(), { waitUntil: "networkidle2" });
  await page.waitForSelector("#broadcast-canvas", { timeout: 10_000 });

  const firstChunkTimer = setTimeout(() => {
    firstChunkReject?.(new Error("No media chunks received from browser within 10s."));
  }, 10_000);

  await firstChunk.finally(() => clearTimeout(firstChunkTimer));
  console.log(`Streaming broadcast in ${mode} mode`);

  let shuttingDown = false;
  shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      chunkServer.stop(true);
    } catch {}
    try {
      await browser.close();
    } catch {}
    try {
      ffmpeg.stdin?.end();
    } catch {}
    try {
      ffmpeg.kill();
    } catch {}
    if (ffplay) {
      try {
        if (ffplay.stdin && typeof ffplay.stdin !== "number") {
          ffplay.stdin.end();
        }
      } catch {}
      try {
        ffplay.kill();
      } catch {}
    }
  };

  const ffmpegExit = ffmpeg.exited.then((code) => {
    void shutdown?.();
    return code;
  });

  process.on("SIGINT", () => {
    void shutdown?.();
  });
  process.on("SIGTERM", () => {
    void shutdown?.();
  });

  const exitCode = await ffmpegExit;
  if (ffplayPump) {
    await ffplayPump.catch(() => {});
  }
  if (ffplay) {
    await ffplay.exited;
  }
  await shutdown?.();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
