# MarbleBot — Robot Transformer (`examples/01-robot-transformer`)

A complete, playable integration example for the **IPFPS** platform: a
Three.js robot-transformer game (collect marbles, transform car ⇄ robot)
with a real economy on top — Solana wallet login, an in-game currency
(`$MARBLE`), a persistent leaderboard, and a shop with unlockable robot
skins.

The entire game — 3D graphics, physics-feel movement, wallet auth, ledger
credits, scores, shop purchases — was **built and wired to IPFPS in a
single AI coding session**. This folder is the reference implementation
you can copy, run, and adapt.

## Prerequisites

- **Python 3.9+** (the local dev server is stdlib-only — no pip installs).
- A **Solana wallet** with the Wallet Standard interface (Phantom,
  Solflare, …) — used for the one-click login. A guest mode is also
  available for the 3D part, but earning/spending requires login.
- An **IPFPS tenant with an S2S key**. Two ways to get one:
  1. Self-service console: open <https://ipfps.org/worldsfair> →
     **Console** → your app → **Reveal Secret** (you get
     `TENANT_HOST`, `TENANT_KEY_ID`, `TENANT_SECRET`; the secret is shown
     once — store it in your `.env`).
  2. API: `POST https://ipfps.org/api/tenants` `{slug?, name}` → `201`
     with `s2s_key:{key_id, secret}` (a first key is minted automatically).

## Setup

```bash
cd examples/01-robot-transformer
cp .env.example .env          # fill in TENANT_HOST / TENANT_KEY_ID / TENANT_SECRET
export $(grep -v '^#' .env | xargs)
python3 server.py
```

Then open **http://localhost:8000** and connect your wallet.

On startup the server prints the bound port/tenant and idempotently
upserts the shop SKU (`transformer_inferno`, 5 $MARBLE), activating it if
freshly created. If the tenant is unreachable you get a clear HTTP error
per call instead of a silent game.

## Controls

| Key | Action |
|---|---|
| `W A S D` / arrow keys | Move (robot: fast, car: very fast) |
| `Q` | Transform robot ⇄ car |
| Mouse | Shop button (top-right) — browse, buy, equip skins |

## Integration map

Every browser call goes to `localhost` first; the browser **never** talks
to IPFPS directly and never sees the S2S secret.

| Frontend calls `localhost:8000` | What `server.py` does | Platform call (S2S = HMAC-signed) |
|---|---|---|
| `POST /api/auth/nonce` `{address}` | Validates the base58 address, then plain proxy (browser-facing auth paths are Origin-exempt) | `GET {tenant}/api/auth/nonce?address=…` (proxied, JWT-free) |
| `POST /api/auth/verify` `{address, signature, …}` | Plain proxy of the wallet-signed verify | `POST {tenant}/api/auth/web3/verify` (proxied) → JWT |
| `POST /api/balance` `{token}` | **S2S introspect** the JWT → `user_id`, then read ledger | `POST /api/tenant/introspect`, `GET /api/tenant/balance/{uid}` |
| `POST /api/earn` `{token, amount, round_id}` | Introspect → **credit 1 $MARBLE per marble**, idempotent per round | `POST /api/tenant/balance/credit` (`tx_type: game_win`, `idempotency_key: round:<uuid>:credit`) + `POST /api/tenant/score` (`score_type: marble`, `idempotency_key: round:<uuid>:score`) |
| `POST /api/inventory` `{token}` | Introspect → player inventory (owns which skins) | `GET /api/shop/inventory` with the player's JWT in `Init-Data` |
| `POST /api/shop/buy` `{token, product_id, idempotency_key}` | Introspect → validate UUID idempotency key → two-phase purchase (debit $MARBLE, grant item) | `POST /api/shop/buy` with `Init-Data` (platform debits the ledger server-side; client-sent money fields are rejected by the platform) |
| `GET /api/leaderboard` | Public read of the custom board | **S2S** `GET /api/tenant/leaderboard?score_type=marble&entity_type=user&season=all_time&limit=50` |
| `GET /api/shop` | Public catalog (server-side prices — the client never sets prices) | **S2S** `GET /api/tenant/products?limit=50` |
| _(startup)_ | Idempotent SKU upsert + activation | **S2S** `PUT /api/tenant/products`, `POST /api/tenant/products/{code}/activate` |

## Security invariant

The S2S secret lives **only in the `server.py` process environment** and
never reaches the browser: the frontend talks exclusively to
`http://localhost:8000`, and every privileged operation (minting credits,
reading balances, server-priced catalog, leaderboard) is executed
server-side against `/api/tenant/*` with an HMAC-SHA256 signature over
the exact raw body bytes (`X-Tenant-Key-Id` + `X-Tenant-Signature`). All
money movement is server-side; the player-facing platform endpoints
reject client-sent amounts/intents by design. `.env` (and any `secret`
file) is gitignored — never commit credentials.

## Architecture

```
┌─────────────┐   plain HTTP (no secrets)   ┌──────────────────┐
│  Browser     │ ───────────────────────────► │  localhost        │
│  index.html  │ ◄─────────────────────────── │  server.py        │
│  Three.js +  │   game /api/* JSON           │  static + proxy   │
│  wallet      │                              └───────┬──────────┘
└─────────────┘                                      │ HMAC-SHA256
                                                         ▼
                                          ┌─────────────────────────────┐
                                          │  {your-app}.demo.ipfps.org  │
                                          │  /api/tenant/*  (S2S)       │
                                          └───────┬─────────────────────┘
                                                  ▼
                                    ┌─────────────────────────────┐
                                    │  IAM · economy ledger ·      │
                                    │  scores/leaderboard · shop   │
                                    │  (microservices)             │
                                    └─────────────────────────────┘
```

- **Browser ⇄ localhost** — the game calls only same-origin dev-server
  endpoints; JWT from web3 verify is kept in page memory.
- **localhost ⇄ IPFPS** — `server.py` signs every S2S call with the
  tenant secret; the tenant is pinned server-side from the key, so no
  slug ever needs to be sent or stored.
- The `proxy()` calls (auth nonce/verify, shop buy/inventory) are
  browser-shaped calls forwarded with the player's JWT in `Init-Data` —
  they stay JWT-authenticated and rate-limited by the platform.

## Troubleshooting

- **`Missing tenant credentials …` on start** — the env vars are empty.
  Run `export $(grep -v '^#' .env | xargs)` from the example folder (or
  set `TENANT_HOST` / `TENANT_KEY_ID` / `TENANT_SECRET` manually).
- **`401 unknown_key` / `403 invalid_signature`** — the key was revoked,
  or the secret doesn't match the key id. Re-check `TENANT_KEY_ID` and
  `TENANT_SECRET` in the console (**Reveal Secret** shows the plaintext;
  every view is journaled). Remember the HMAC key is the secret's raw
  ASCII hex string, not the decoded bytes.
- **`429 SLOW_DOWN`** — you're hitting a platform rate bucket (game
  credits/buys are money-adjacent and intentionally tight). Slow the
  loop; retries are safe because every write carries an idempotency key.
- **Login button does nothing / wallet not found** — the page needs a
  Wallet-Standard browser extension (Phantom/Solflare); incognito mode
  usually hides extensions. Also make sure the tenant has Solana enabled
  (`solana_enabled`), otherwise nonce returns `403 web3_disabled`.
- **Black screen / robot doesn't render** — Three.js is loaded from a
  CDN, so the game needs internet access even in guest mode; check the
  browser console for blocked `unpkg`/`cdn` requests.
