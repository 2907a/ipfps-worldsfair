# Vibe-Coding MarbleBot on IPFPS — Real Session Transcript (2026-10-13)

> **Disclaimer.** This is a condensed and lightly edited transcript of a real
> Kimi Code session (`session_b9f81454-6a71-4c0b-9d33-d1a656fb14ed`, workspace
> `ipfps-worldsfair`). Prompts are quoted or compressed verbatim; agent replies
> are summarized. The session export ships in this repository as
> `kimi-export-session_-20261013-102133.md`. Tenant credentials
> appearing in the original log (the S2S secret) are **masked here** and the
> live key has since been rotated; do not publish secrets in real projects.
>
> **Trim note.** The owner trimmed post-demo follow-up chatter from this export;
> the demo-relevant conversation ends at step 4 (export of 2026-10-13). No
> product code changed after this session except repository reorganization
> edits (file moves, env-based config, docs) — see git history. The export's
> front-matter counters (123 messages / 104,807 tokens) describe the full
> original session; the trimmed file itself holds 5 turns / 46 tool calls,
> roughly 35–40k tokens (approximate, estimated from text volume).

The user had **zero prior context** about IPFPS. The only platform artefacts
available were the live spec at `https://ipfps.org/worldsfair/IPFPS_AGENT_SPEC.md`
and a local `secret` file with the tenant's S2S credentials
(`robot-game.demo.ipfps.org`, key id `robot-game-key-1`).

---

## Step 1 — "a simple robot game in three js" (05:34)

> **Prompt:** *"i want to build a simple robot game in three js in 1 simple html
> file in robot-game — i want it to collect marbles and save it to leaderboard
> and transform on q - its a robot transformer"*

**Agent actions.** Wrote a single self-contained `robot-game/index.html`
(Three.js from CDN): a box-built transformer robot with a glowing visor that
smoothly animates robot ⇄ car on **Q**, 24 spinning marbles in 5 colors,
60-second rounds, WASD/arrows + chase camera, and a localStorage leaderboard
(top 20 kept, top 10 shown).

**Platform touchpoints.** None — pure frontend.

**Result.** Playable single-file game; structure verified with a Python
sanity script (brace balance, function and DOM-id presence).

## Step 2 — "run it for me locally" (05:38)

> **Prompt:** *"can you run it for me locally in localhost"*

**Agent actions.** Started `python3 -m http.server 8000 --directory robot-game`,
confirmed HTTP 200.

**Result.** Game served at `http://localhost:8000`.

## Step 3 — "$MARBLE on the leaderboard, login with Solana" (05:41)

> **Prompt:** *"make it so it moves faster … i want each marble to be in game
> currency and saved in leaderboard ticker $MARBLE and i want to login with
> solana — secrets in that file for ipfps"* (links the live `IPFPS_AGENT_SPEC.md`)

**Agent actions.**

1. Fetched the full agent spec (~66 KB) and read only the relevant sections
   (quickstart, auth §3.1, frontend API §4, S2S API §5, economics §6,
   leaderboards §11).
2. Read the local `secret` file (S2S secret, key id, tenant host).
3. **Probed the live tenant** before writing any code:
   - `GET /api/deposit/config` → `401 unauthorized` — discovered that even
     "Origin-exempt" public paths still require an `Origin` header in practice;
     retried with `-H 'Origin: https://robot-game.demo.ipfps.org'` → `200`
     (`tokens:[]`, confirming crypto deposit policies are operator-registered),
     and `GET /api/auth/nonce?address=…` → `200` (Solana auth enabled).
4. Wrote `server.py` — a stdlib-only Python backend: static file serving plus
   an S2S proxy so the **secret never reaches the browser**. Routes:
   `/api/auth/nonce`, `/api/auth/verify` (plain proxy with `Origin`), and
   token-gated `/api/balance`, `/api/earn`, `/api/leaderboard` (HMAC-signed S2S).
5. Rewrote `index.html`: "Connect Solana Wallet" (Phantom via
   `signMessage` over the spec's exact nonce message), doubled movement speed,
   `$MARBLE` HUD, guest mode kept as local-only fallback.
6. **First live S2S call failed** with `401 invalid_signature`: the agent had
   HMAC-keyed with `bytes.fromhex(secret)`, but the platform keys the HMAC with
   the secret's **raw ASCII form** (openssl `-hmac` style). Fixed one line,
   restarted, verified.

**Platform touchpoints.** `GET /api/auth/nonce` · `POST /api/auth/web3/verify` ·
`POST /api/tenant/introspect` (JWT → user_id) · `GET /api/tenant/balance/{user_id}` ·
`POST /api/tenant/balance/credit` (`currency:"MARBLE"`, `tx_type:"game_win"`,
idempotency key `round:<round_id>:credit`) · `POST /api/tenant/score`
(`score_type:"marble"`) · `GET /api/tenant/leaderboard?score_type=marble`.

**Result.** End-to-end verified with curl: signed leaderboard returns 200,
nonce proxy works, bogus tokens rejected with `401 invalid_token`, bogus
addresses with `400 invalid_address`. (Phantom popup signing itself is
browser-only, noted honestly.)

## Step 4 — "a shop, transformer for 5 marble, toasts, lock states" (05:53)

> **Prompt:** *"ok, make a shop where i can buy a different transformer robot
> for 5 marble coins. i want to also see any errors or success toasts — if
> another item is locked or unlocked for me"*

**Agent actions.**

1. Read shop contracts: player-facing §4.5 and S2S §9 (inventory & digital goods).
2. Backend: `ensure_products()` at startup — idempotent `PUT /api/tenant/products`
   upsert of SKU `transformer_inferno` (price 5 `MARBLE`, kind `digital`,
   content `{"skin":"inferno"}`) followed by `POST …/activate`; proxy routes
   `/api/shop` (S2S catalog), `/api/inventory` and `/api/shop/buy`
   (JWT-introspected, UUID-validated `idempotency_key`).
3. Frontend: shop panel, live skin switching, locked/unlocked/owned/equipped
   badges verified **against the live IPFPS inventory** (survives across
   devices), toasts for success/error/pending — including two-phase rejection
   detection (buy is never a funds error at buy-time; the item flips
   `pending_payment → active | rejected`).
4. Fixed two self-inflicted bugs caught by curl probes (shop route registered
   only for POST → moved to `do_GET`; a bad edit glued two lines together).

**Platform touchpoints.** `PUT /api/tenant/products` ·
`POST /api/tenant/products/{code}/activate` · `GET /api/tenant/products` ·
`GET /api/shop/inventory` (player JWT) · `POST /api/shop/buy`.

**Result.** Catalog live (SKU id `10000000052` at 5 $MARBLE); leaderboard
already had real entries — the user had earned **16 $MARBLE** in an earlier
round, rank #1.

---

## Timeline

| # | Prompt (compressed) | Feature shipped | IPFPS API used |
|---|---|---|---|
| 1 | robot game in Three.js, marbles, leaderboard, transform on Q | single-file 3D game + localStorage board | — |
| 2 | run it locally | localhost:8000 static server | — |
| 3 | faster + $MARBLE currency + Solana login (agent spec + secret file) | S2S proxy backend, web3 login, ledger credit, custom `marble` leaderboard slice | `/api/auth/nonce`, `/api/auth/web3/verify`, `/api/tenant/introspect`, `/api/tenant/balance/*`, `/api/tenant/score`, `/api/tenant/leaderboard` |
| 4 | shop: transformer skin for 5 $MARBLE, toasts, lock states | digital-goods shop, two-phase buy, inventory-verified unlocks, toasts | `/api/tenant/products*`, `/api/shop/inventory`, `/api/shop/buy` |

**Takeaway.** One spec URL + one secrets file were enough for an agent with no
prior IPFPS knowledge to ship, live against production: web3 auth, a custom
currency, idempotent money movement, a custom leaderboard slice and a digital
goods shop — in seven prompts, with every backend call verified by curl.
