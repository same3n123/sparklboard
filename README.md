# SparkBoard Assistant service

A ~200-line Express service that turns a learner's sentence into **SparkBoard commands**.
It is the only place an API key exists. The page never sees it.

```
browser  ──POST /api/assistant──▶  this service  ──▶  Claude (claude-sonnet-5)
   ▲                                     │
   └──── { reply, bullets, commands } ◀──┘
```

The page then runs each returned command through the **same deterministic interpreter**
a typed command goes through (`AGENT.intent()` → `AGENT.do_*`). The model chooses *what to
try*; `MECHANICS.compatible()`, `ifWirePlan()` and each block's `validate()` still decide
what is *possible*. A misread sentence can act on the wrong part — it can never invent a
connection the simulator would refuse. Anything outside the command grammar is dropped by
the page and reported as "I could not do that on this canvas."

## Deploy on Render

1. Push this repository to GitHub (the `server/` folder is all that matters).
2. Render → **New → Web Service** → pick the repo.
   Render reads `server/render.yaml`, or set it by hand:
   - Root Directory: `server`
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Add the environment variable **`ANTHROPIC_API_KEY`** with your key. That is the only
   required one.
4. Deploy, then check `https://<your-service>.onrender.com/health` → `{"ok":true,...}`.

The free plan sleeps after 15 minutes idle, so the first question after a quiet spell
takes ~30 s to wake the service. Everything in SparkBoard keeps working while it sleeps.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Your Anthropic key. Never put this in `index.html`. |
| `MODEL` | no | Defaults to `claude-sonnet-5`. |
| `ALLOWED_ORIGINS` | no | Comma-separated sites allowed to call it. `*` by default; set it to your site's address once you have one. |
| `APP_TOKEN` | no | A shared secret. If set, the page must send it — type `ai token <secret>` in the Assistant. |
| `MAX_PER_MINUTE` | no | Requests per IP per minute. Default 20. |

## Turning it on in SparkBoard

Open 💬 Assistant and type:

```
ai https://your-service.onrender.com
```

That address is remembered in this browser (`localStorage`), so each Chromebook is set up
once. `ai off` goes back to the built-in interpreter alone; `ai` on its own says which
mode is running. To ship it pre-configured, set `AI_ENDPOINT` near the top of the AGENT
block in `index.html` instead.

**The published Artifact cannot reach this service** — its Content Security Policy blocks
every external host. AI mode works when `index.html` is opened locally, or served from
your own host. The Artifact keeps the built-in deterministic assistant, unchanged.

## Run it locally

```bash
cd server && npm install && ANTHROPIC_API_KEY=sk-ant-... npm start
```

Then `ai http://localhost:3000` in the Assistant.

## Cost

One question is roughly 1.5–2k input tokens (mostly the cached system prompt) and a few
hundred output tokens. The system prompt is marked `cache_control: ephemeral`, so repeat
questions in a session read it from cache. `effort: "low"` keeps thinking short — this is
a translation job, not a reasoning one. `MAX_PER_MINUTE` is the backstop.
