# bruh.help

Live AI battles for developer errors & logs.

Every round is fully automatic:
- Pull a real recent Stack Overflow error question
- Two AI contestant models generate fixes
- Two AI judge models vote with reasoning
- 30s public voting from browser buttons
- Winner + per-language leaderboard updates

No user prompt submission, uploads, or paste flow is enabled.

## Stack

- Bun + TypeScript
- Bun.serve + WebSocket (`/ws`)
- SQLite (`bun:sqlite`)
- AI SDK (`ai`) with pluggable providers (`@ai-sdk/groq`, `@ai-sdk/openai`)
- React pages (live, admin, history, broadcast)
- shadcn-style component layer + Tailwind utility classes

## Provider Modes

Set `AI_PROVIDER` in `.env`:
- `groq` (default)
- `openrouter`
- `openai-compatible` (generic OpenAI-compatible endpoint)

OpenRouter uses `OPENROUTER_API_KEY` and defaults to `https://openrouter.ai/api/v1`.
`openai-compatible` uses `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL`.

## Models (defaults)

Contestants:
- `Llama 3.1 8B`
- `Gemma 2 9B`

Judges:
- `Qwen 32B Judge`
- `Llama 3.3 70B Judge`

Provider-specific model IDs are preconfigured and can be overridden via:
- `MODEL_CONTESTANT_A_ID`
- `MODEL_CONTESTANT_B_ID`
- `MODEL_JUDGE_1_ID`
- `MODEL_JUDGE_2_ID`

## Setup

1. Copy env file:

```bash
cp .env.example .env
```

2. Fill required values:
- `AI_PROVIDER`
- provider key(s) for your chosen mode
- `STACK_EXCHANGE_KEY`
- `ADMIN_SECRET`

3. Install and run:

```bash
bun install
bun run start
```

App URLs:
- Live: `http://localhost:5109/`
- History: `http://localhost:5109/history`
- Admin: `http://localhost:5109/admin`
- Broadcast canvas: `http://localhost:5109/broadcast`

## Deployment

### Railway

- Create new Railway service from repo
- Set required env vars
- Start command: `bun server.ts`
- Exposed port: `PORT` (Railway injects)

### Fly.io

- `fly launch`
- Add env vars via `fly secrets set`
- Deploy: `fly deploy`

## Notes

- Stack Exchange polling is rate-safe:
  - <= 30 requests/second per IP
  - identical query no faster than once per 60s
  - honors `backoff` from API responses
- Question cache is persisted in SQLite + memory queue prefetch.
- Admin supports pause/resume/export/reset without restarting process.
