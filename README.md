# IPFPS — Production Web3 Backend for AI-Built Frontends

**Provision, sign, ship.** Your product is a *tenant*: an isolated slice of a
running production platform — its own users, balances in your own currency
codes, ledger with escrow holds, shop, leaderboards, referrals, realtime and
notifications — reachable through one gateway, authenticated by one HMAC
secret. A JWT minted for tenant A is rejected on tenant B; rate limits,
leaderboards and WS fan-out never cross tenants.

**Live sandbox:** https://ipfps.org/worldsfair · **Agent Spec:** [specs/AGENT_SPEC.md](specs/AGENT_SPEC.md) · **OpenAPI:** [specs/openapi.yaml](specs/openapi.yaml) (3.0.3, 75 paths)

## The gap

An AI agent builds a credible frontend in hours. The backend that makes it a
product — auth, a ledger that cannot double-spend, multichain deposits,
realtime fan-out, notifications, funnels — is months of unglamorous,
security-critical work. This repository closes that gap with a single
agent-readable spec against a platform that is already in production.

Every claim here is verifiable by a stranger in one evening: the spec pins
each contract to the running codebase, the demo tenant is live and playable,
the session transcript is unedited, and the quickstart below creates a real
tenant under your own wallet.

## What you can build

Everything below is one signed HTTPS call away; the full contract for each is
in [specs/AGENT_SPEC.md](specs/AGENT_SPEC.md) (§16 has copy-paste recipes).

| Idea | Mechanism | Status |
|---|---|---|
| Stakes / player-vs-player escrow | `balance/hold` debits the stake; `settle` captures, `release` refunds — no double-spend by construction | **Live** |
| Skin shop in your in-game currency | SKU upsert with opaque JSON payload; two-phase `shop/buy` flips `pending_payment` to `active` or `rejected` | **Live** |
| Digital goods for USDC | player sends SPL/USDC to your per-tenant escrow; scanner credits your currency at a published rate; then the normal shop | **Live** (Solana) |
| Telegram mini-app | `POST /api/auth/tg` verifies init-data HMAC against your tenant's bot token; session JWT, nothing else to build | **Live** |
| Referral machine with rev-share tiers | referral graph per tenant + opt-in tiered %-of-deposit engine (`referral_config`, default off) | **Live** |
| Seasonal leagues | polymorphic score slices: `(score_type, entity_type, season)`; a season is any string you choose, slices live forever | **Live** |
| Subscriptions | recurring `hold` → `settle` per billing period; `release` cancels; proration is your arithmetic, atomicity is ours | **Live** |
| Loot boxes with reserve | `hold` the box price at purchase, `settle` on open, `release` inside the refund window | **Live** |
| Omnichannel CRM | inbound per-tenant TG bot (long-poll + WebApp button), magic-link email, web push, and signed webhooks (`user.registered`, `deposit.confirmed`, `referral.linked`) to your backend | **Live** |
| Multichain deposits | Solana native + SPL live; EVM / TON / Tempo ride the same token-policy → escrow → scanner pattern — contracts published in the spec before activation | **Solana Live · EVM/TON/Tempo Rolling out** |

## Architecture

```
   Browser ──────────►  Your S2S proxy  ──────────►  IPFPS Cloud (one gateway)
   player JWT in        holds the secret;           resolves the tenant from
   `Init-Data` header   signs every call:           the host, then routes to
                        HMAC-SHA256(raw body)        capability blocks:
   money moves ONLY through                        ┌───────────────────────────┐
   your signed backend                             │ Multi-chain deposits      │
   calls — never client-side                       │ Ledger + balance holds    │
                                                   │ Shop + inventory          │
        auth: Solana web3 · local ·                │ Leaderboards + seasons    │
        magic link · Telegram ·                    │ Referrals + tasks         │
        Discord                                    │ Notifications TG·email·   │
                                                   │  push · signed webhooks   │
                                                   │ Realtime WS · Analytics   │
                                                   └───────────────────────────┘
```

You integrate against one gateway. The 19-service mesh behind it is our
problem.

Two credential types, no others: humans get a 30-day JWT in the **`Init-Data`**
header (never `Authorization: Bearer`); servers get an HMAC-SHA256 signature
over the exact raw request body, keyed by a per-tenant secret with live
mint/revoke. Player-facing deposit is a hosted-page redirect — the ledger is
never written from the client.

## 5-Prompt Demo — MarbleBot

The example game ([examples/01-robot-transformer/](examples/01-robot-transformer/))
was built by an AI agent in one real session against the **production**
platform, starting from zero IPFPS knowledge — transcript:
[VIBE_CODING_SESSION.md](VIBE_CODING_SESSION.md).

1. *"robot game in three.js, marbles, leaderboard, transform on Q"* → single-file 3D game.
2. *"run it locally"* → `python3 -m http.server`.
3. *"each marble = $MARBLE on a leaderboard, login with Solana"* → a stdlib-only
   S2S proxy appears; the agent probes the live tenant, fixes its own HMAC
   bug, and credits real `MARBLE` on a custom `marble` leaderboard slice.
4. *"shop: transformer skin for 5 $MARBLE, toasts, lock states"* → digital-goods
   shop; unlocks verified against the live inventory.
5. *"i accidentally deleted the whole folder"* → restored from context in
   minutes — because balances, unlocks and leaderboard lived on the platform,
   not in the folder.

Seven prompts, one evening-class session, every backend call verified with
curl against production.

## Repository map

| Path | What it is |
|---|---|
| [specs/AGENT_SPEC.md](specs/AGENT_SPEC.md) | The complete agent integration reference — the only document an AI agent needs. Every path, header, field and error code verified against the running codebase. |
| `specs/openapi.yaml` | Formal OpenAPI 3.0.3 spec of the public gateway (75 paths: auth, user API, self-service tenants, S2S). |
| `sdk/python/ipfps_client.py` | Stdlib-only Python S2S client — no pip installs. |
| `sdk/js/ipfps.js` | Browser client + Node signer (built-in `crypto`, zero deps). |
| [examples/01-robot-transformer/](examples/01-robot-transformer/) | MarbleBot: Three.js game + `server.py` S2S proxy + `.env.example` + its own [README](examples/01-robot-transformer/README.md). Live tenant: `robot-game.demo.ipfps.org`. |
| [showcase/worldsfair-pavilion/](showcase/worldsfair-pavilion/) | Snapshot of the live World's Fair site: Three.js landing + developer console (wallet login → tenant CRUD → key mint → live balances). |
| [VIBE_CODING_SESSION.md](VIBE_CODING_SESSION.md) | Condensed transcript of the real session that built MarbleBot on the live platform. |
| `kimi-export-session_-20261013-102133.md` | Raw session export (trimmed to the demo conversation). |
| [LICENSE](LICENSE) | MIT. |

## Quickstart — ~15 minutes

1. **Wallet → sandbox.** Open https://ipfps.org/worldsfair, connect a Solana
   wallet, create a tenant (`my-game`), reveal the S2S secret (shown once).
   Your tenant origin `https://my-game.demo.ipfps.org` exists immediately.
2. **Configure the example.** `cd examples/01-robot-transformer &&
   cp .env.example .env` — fill in `TENANT_HOST`, `TENANT_KEY_ID`,
   `TENANT_SECRET`.
3. **Run.** `python3 server.py` → http://localhost:8000 — a game with Solana
   login, a real currency and a shop, running against your tenant.
4. **First signed call from your own shell** (bash + openssl; GET signs the
   empty string; full details in spec §2 and §5):

```bash
BODY='{"user_id":"018f…","currency":"COINS","amount":1000,"tx_type":"credit","comment":"QA","idempotency_key":"qa-0001"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s -X POST "https://my-game.demo.ipfps.org/api/tenant/balance/credit" \
  -H "X-Tenant-Key-Id: $KEY_ID" -H "X-Tenant-Signature: $SIG" \
  -H 'Content-Type: application/json' -d "$BODY"
# → 200 {"user_id":"018f…","currency":"COINS","balance_after":1000.0}
```

The same four steps work headlessly (self-service API, no browser): spec §2.

## Capability matrix

Status vocabulary is deliberately two-valued — **Live** (in production, with
real tenants depending on it) or **Rolling out** (contracts published in the
spec, implementation in progress). There is no third bucket; anything not
listed here is not claimed.

| Capability | Status | Mechanism |
|---|---|---|
| Solana deposits (native SOL + SPL/USDC) | **Live** | per-tenant escrow wallets; scanner attributes by `(chain, escrow)`, credits your internal currency at a published rate; idempotent crediting + manual `deposit/verify` |
| EVM · TON · Tempo rails | **Rolling out** | same token-policy → escrow → scanner pattern; contracts published in spec §7.1 before activation; no public endpoints yet |
| Ledger + balance holds | **Live** | PostgreSQL; `CHECK (amount >= 0)`; a hold is an immediate debit; settle/release take a row lock on the hold; `settle_full` runs both legs in one tx — a failed debit rolls back the credit |
| Shop / digital goods | **Live** | two-phase buy: item `pending_payment → active` (content snapshot at activation) or `rejected`; content served to the owner of an `active` item only, everything else masked `404` |
| Leaderboards + seasons | **Live** | polymorphic slices `(score_type, entity_type, season)`; season = any string; levels move only on your configured source slice |
| Referral graph + rev-share tiers | **Live** | graph of edges per tenant; tiered %-of-deposit engine is explicit per-tenant opt-in (`referral_config`), default off — without it the graph is pure data |
| Tasks + faucet + streak | **Live** | per-tenant economics read fail-closed: no config key for your slug → that reward is off |
| TG · email · push · webhooks | **Live** | per-tenant TG bot (inbound long-poll + WebApp button); magic-link email; web-push subscriptions; signed at-least-once webhooks with 30s→2m→10m→1h backoff, DLQ after 5 attempts |
| Realtime WS | **Live** | one tenant-scoped socket: `balance_update`, `deposit_confirmed`, `xp_update`, `leaderboard_update`, live feed, lobby chat |
| Self-service tenants + S2S keys | **Live** | wallet-verified account, ≤3 tenants; two active key slots; revocation is live in the edge key store — `403 unknown_key` at once |
| Analytics OLAP | **Rolling out** | ClickHouse sink fed over JetStream; tenant-custom event types on the beacon whitelist are rolling out |

## Live production tenants

| Tenant | What runs there |
|---|---|
| `robot-game.demo.ipfps.org` | MarbleBot — the example game in this repo; create an account and check the `marble` board |
| ludamax | external games tenant — live Solana USDC deposits into per-tenant escrow, dedicated Telegram bot |
| folderz | external app tenant — encrypted file vault on S3, native Android client |
| pool · tusslepuffs · heartui | external products integrated purely over the Tenant S2S API |

Custom domains and token deposit policies are operator-side:
support@ipfps.org.

## Security invariants

- **Secrets live server-side only.** The S2S secret never reaches a browser;
  the example proxies every signed call through `server.py`. Compromised? Email
  `KEY COMPROMISE — <slug>` from your registered contact address — the key is
  revoked live and re-issued.
- **HMAC over raw body bytes.** `X-Tenant-Signature = hex(HMAC_SHA256(secret,
  raw_request_body))`, constant-time compared; GET signs the empty string.
- **Idempotency keys on money.** `balance/hold`, `balance/credit`,
  `balance/settle_full` require `idempotency_key` (one namespace per tenant —
  prefix your own: `round:…`, `shop:…`); same key + same payload replays the
  original result, funds move exactly once.
- **404 masking.** Unknown users, foreign users and other tenants' resources
  are indistinguishable — everything answers `404`, never `403`; existence is
  not revealed.
- **Rate buckets per tenant and per principal.** Token-bucket limits including
  a dedicated `tenant_s2s` bucket (10 rps / burst 60 per slug); on `429` honor
  `Retry-After`.

## License

[MIT](LICENSE) — Copyright 2026 IPFPS (2907a). Scope: integration examples,
SDK helpers, specs and showcase code.
