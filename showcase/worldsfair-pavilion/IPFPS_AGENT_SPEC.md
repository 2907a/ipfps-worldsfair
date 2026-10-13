# IPFPS — Complete Agent Integration Spec

**Audience:** an AI agent (or a developer driving one) with **zero prior context** about IPFPS, integrating a finished product — a game, a Telegram mini-app, a marketplace, a browser extension — with the IPFPS multi-tenant gaming platform. This file is the *only* context you need: user-facing and server-to-server contracts are both here.

**Source of truth:** every path, header, field, limit and error string below was verified against the running codebase (HEAD `3b3c3e4`). Where the human-facing guide `IPFPS_INTEGRATION.md` and the code disagree, this document follows the code; the deltas are listed at the end ("Known doc drift"). Contact: support@ipfps.org.

## TL;DR

1. IPFPS is a multi-tenant backend PaaS for games and apps: your product is a **tenant** — an isolated production slice (own users, ledger in your own currency codes, shop, leaderboards, chat, realtime, config) keyed by a unique slug, reachable at `https://{slug}.demo.ipfps.org`.
2. You provision a tenant with **one API call** (`POST /api/tenants`, web3 account required) and get back a slug, a config object and an S2S keypair. It is live immediately — wildcard demo perimeter, on-demand Let's Encrypt TLS.
3. Players authenticate against the platform and receive a 30-day JWT sent in the **`Init-Data`** header; your backend calls the **Tenant S2S API** (22 endpoints) signed with HMAC-SHA256 over the exact raw body.
4. Money moves **server-side only**: holds, settle, release, settle_full, credits, shop purchases — all idempotent, all constrained by a non-negative ledger CHECK, all confirmable over signed webhooks.
5. Read §1 to pick your architecture, §2 to be live in 15 minutes, §4 for the mechanics, §5 for exact contracts.

**Conventions:** `BASE` = your tenant origin (`https://{slug}.demo.ipfps.org` for self-service tenants); `PLATFORM_BASE` = the platform origin (`https://ipfps.org`). All bodies are JSON, UTF-8. Browsers send `Origin` automatically; curl needs `-H 'Origin: …'` unless the route is Origin-exempt (listed at §3 and in the tables). Timestamps are epoch **milliseconds** in fields like `nextAvailableAt`, ISO-8601 in fields named `*_at`. Errors are JSON `{"error":"<stable_machine_code>"}`.

---

## 1. What you can build

Twelve proven shapes. Each names the platform mechanics it composes and where the contracts live. All statuses are deployment facts: everything is either **Live** or labelled *rolling out* — and rolling-out items have **no endpoints to call** (§8).

**1. Web3 game with stakes — Live.** Stake a round via S2S `balance/hold` (funds debited immediately, no double-spend), capture a loss with `balance/settle`, refund with `balance/release`, pay out atomically with `balance/settle_full`. `round_id` correlates every leg with your round. → [§4.1](#41-money-ledger-and-holds), [§5.2](#52-tenant-s2s-endpoints)

**2. Skin shop in your own currency — Live.** Upsert SKUs from your backend (`PUT /api/tenant/products`, price in any currency code), players buy via the two-phase `POST /api/shop/buy` (`pending_payment → active/rejected`), item content is snapshotted at activation. → [§4.3](#43-shop-and-inventory)

**3. Digital goods for USDC — Live on Solana.** Player links a wallet, sends USDC/SPL/native SOL to your per-tenant escrow, is credited your internal currency at a published rate, then buys through the normal shop. Hosted deposit page: none — it is a wallet transfer plus a scanner. → [§4.2](#42-deposits-and-multichain-rails)

**4. Telegram mini-app — Live.** Your BotFather token (operator-registered, per tenant) verifies `WebApp.initData` at `POST /api/auth/tg`; the same bot is long-polled by the platform for inbound messaging and join-task verification. → [§3.4](#34-telegram-mini-app-login), [§4.5](#45-notifications)

**5. Referral machine with rev-share — Live (engine opt-in).** A per-tenant referral graph with `source` attribution comes free; tiered percentage-of-deposit rev-share plus per-edge welcome grants flip on via `app_settings.referral_config` — **default OFF for every tenant**. Or keep the graph and pay rewards yourself off the `referral.linked` webhook. → [§4.4](#44-growth-referrals-seasons-and-tasks)

**6. Seasonal league — Live.** Scores are polymorphic slices `(score_type, entity_type, season)`: run an `arena_rating` board, a `squad` board and a `halloween_2026` season in parallel, each addressable by string tokens. Rotation is just starting a new season string; slices are never deleted. → [§4.4](#44-growth-referrals-seasons-and-tasks)

**7. Subscriptions on balance holds — Live.** Recurring access without touching fiat: `balance/hold` the renewal amount, `settle` to charge, `release` to cancel. Holds are first-class ledger state, idempotent by `hold_id`, and live until you close them. → [§4.1](#41-money-ledger-and-holds)

**8. Lootbox with a funds reserve — Live.** Debit the spin cost upfront (`balance/hold`), resolve the roll server-side, pay the prize in one atomic two-leg call (`settle_full` rolls back **both** legs if the debit would overdraw — no half-paid state exists). → [§4.1](#41-money-ledger-and-holds)

**9. NFT-style inventory items — Live.** A SKU's `content` is arbitrary JSON (≤512 KB) stored opaque and delivered byte-for-byte; the buyer's copy is frozen at activation time, so later catalog edits never mutate what owners hold. Grant on `status:"active"` only. → [§4.3](#43-shop-and-inventory)

**10. Omnichannel notifications — Live.** Platform→backend webhooks (HMAC-signed with your S2S secret, at-least-once, retries 30 s → 2 min → 10 min → 1 h, dead-letter after 5), a per-tenant TG bot channel, email magic links, and realtime WS frames: `balance_update`, `xp_update`, `deposit_confirmed`, `leaderboard_update`. → [§4.5](#45-notifications), [§4.6](#46-realtime-websocket)

**11. Multichain deposits — Solana Live; EVM/TON rolling out.** The `token_policies` pattern (one row per token: chain, token address, per-tenant escrow, published rate, min/max range, internal currency) is chain-agnostic by construction. EVM and TON activate the identical scanner→ledger pipeline and extend `GET /api/deposit/config` the same way. Capability statement, no endpoints yet: [§4.2](#42-deposits-and-multichain-rails), [§8](#8-operator-only-and-rolling-out)

**12. Quests and retention loops — Live.** Task templates with server-side verifiers, faucet, daily streak with per-day reward tables, a configurable level curve, XP-from-ledger conversion rules. Every knob is per-tenant and hot-reloaded; only the economics keys beyond the welcome bonus are operator-set (§8). → [§4.4](#44-growth-referrals-seasons-and-tasks), [§6](#6-config-reference)

---

## 2. Zero to live in 15 minutes

Prerequisites: a Solana wallet (Phantom/Solflare), curl + python3. After step 1 your tenant exists at `BASE=https://{slug}.demo.ipfps.org` (wildcard demo perimeter, on-demand Let's Encrypt — the first hit may pause for certificate issuance; unknown slugs get `404 unknown_tenant` and no cert).

**Step 0 — wallet login on the platform origin** (self-service tenant creation demands a web3-verified account). Fetch a nonce, sign the message (exact format in §3.1), verify:

```bash
NONCE=$(curl -s "$PLATFORM_BASE/api/auth/nonce?address=$WALLET" -H "Origin: $PLATFORM_BASE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["nonce"])')
# Sign in the wallet:  "Welcome to IPFPS.\nTo authenticate, please sign this message to verify your wallet ownership.\nNonce: $NONCE"
PLATFORM_JWT=$(curl -s -X POST "$PLATFORM_BASE/api/auth/web3/verify" -H "Origin: $PLATFORM_BASE" \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$WALLET\",\"chain\":\"solana:mainnet\",\"walletName\":\"Phantom\",\"message\":\"$MSG\",\"signature\":\"$SIG\",\"device_id\":\"cli\",\"language\":\"en\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

**Step 1 — create the tenant** (≤3 per web3 account; slug `^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$`; reserved names + duplicates → `409 slug_taken`):

```bash
curl -s -X POST "$PLATFORM_BASE/api/tenants" -H "Origin: $PLATFORM_BASE" \
  -H "Init-Data: $PLATFORM_JWT" -H 'Content-Type: application/json' \
  -d '{"slug":"my-game","name":"My Game"}'
# → 201 {"slug":"my-game","type":"external","config":{...},
#        "s2s_key":{"key_id":"...","secret":"<64 hex — SHOWN ONCE, store it in a secrets manager>"}}
```

**Step 2 — configure** (jsonb merge on `apps.config`; takes effect live, no restarts):

```bash
curl -s -X PATCH "$PLATFORM_BASE/api/tenants/my-game" -H "Origin: $PLATFORM_BASE" \
  -H "Init-Data: $PLATFORM_JWT" -H 'Content-Type: application/json' \
  -d '{"config":{"welcome":{"currency":"COINS","amount":100},"webhook_url":"https://your-server/hook"}}'
```

**Step 3 — first S2S call.** Credit a player (bash + openssl):

```bash
KEY_ID='...'; SECRET='...'   # from step 1
BODY='{"user_id":"018f...","currency":"COINS","amount":1000,"tx_type":"credit","comment":"QA","idempotency_key":"qa-0001"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s -X POST "$BASE/api/tenant/balance/credit" \
  -H "X-Tenant-Key-Id: $KEY_ID" -H "X-Tenant-Signature: $SIG" \
  -H 'Content-Type: application/json' -d "$BODY"
# → 200 {"user_id":"018f...","currency":"COINS","balance_after":1000.0}
```

**Step 4 — first player call.** Register a player on your tenant origin and read the profile:

```bash
TOKEN=$(curl -s -X POST "$BASE/api/auth/register" -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -d '{"username":"player_one","password":"Passw0rd123","consent_terms":true,"consent_privacy":true,"language":"en"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s "$BASE/api/user/me" -H "Init-Data: $TOKEN" -H "Origin: $BASE"
# → balances include the 100 COINS welcome bonus from step 2
```

**Verify the host early:** `curl -s "$BASE/api/deposit/config"` → `200` with `"tokens":[]` — confirms TLS and tenant resolution end-to-end.

**Tenant lifecycle (self-service):** everything below takes the platform JWT in `Init-Data` on `PLATFORM_BASE` and is owner-scoped; a foreign slug answers **404 `not_found`**, never 403 — existence is not revealed.

| Method & path | Response |
|---|---|
| `POST /api/tenants` `{slug?, name}` | `201 {slug, name, type, config, s2s_key:{key_id, secret}}` — secret shown once; a first key is minted automatically |
| `GET /api/tenants/mine` | `{tenants:[{slug, name, type, config, hosts, is_active, created_at}]}` |
| `GET /api/tenants/{slug}` / `PATCH /api/tenants/{slug}` `{config:{…}}` | read / jsonb-merge update (writable keys: §6; ops-only `payments`/`tg_bot_token` are silently stripped) |
| `POST /api/tenants/{slug}/s2s-keys` | `201 {key_id, secret}` — **two active key slots max**; a third mint → `409 key_slots_full` (revoke first) |
| `GET /api/tenants/{slug}/s2s-keys` | `{keys:[{key_id, active}]}` — no secrets |
| `GET /api/tenants/{slug}/s2s-keys/{key_id}/secret` | `{secret}` — plaintext, owner only; **every view journaled** (`auth.app_audit`) |
| `DELETE /api/tenants/{slug}/s2s-keys/{key_id}` | `204` — live removal from the edge key store |

Audit trail records `tenant_create`, `config_patch`, `s2s_key_mint`, `s2s_secret_view`, `s2s_key_revoke` (actor = your user id). Rotation procedure: mint a second key → migrate traffic → revoke the old one; both keys verify in parallel during the overlap (your webhook verifier must accept both secrets — see "Known doc drift" #1).

---

## 3. Authentication

All auth methods return the same envelope: `200 {"token":"eyJ...","is_new_user":true|false}` (TG auth adds `username`/`has_password`). JWT claims: `user_id` (UUIDv7), `auth_provider`, `app_slug` (== `aud`), `exp` = now + **30 days**, HS256. **There is no refresh token — refresh = re-run the auth flow.** Store the token in localStorage, send it in the `Init-Data` header on every API call; on any `401` drop it and re-authenticate.

Transport rules everywhere in this section:

- JWT goes in the **`Init-Data`** header; `Authorization: Bearer` is ignored.
- Browser calls need an `Origin` header matching your tenant hosts (curl: add it manually). Origin-exempt paths: `/api/auth/*`, `/auth/magic`, `GET /api/deposit/config`, `/api/tenant/*`, `/payment/*`, `/webhooks/*`, `/api/gateway/*`, health checks.
- Errors are JSON `{"error":"<stable_machine_code>"}`.

### 3.1 Solana web3 login

Nonce properties (verified in `services/iam/repositories/user/users.go:645`): 5-minute expiry, single use (burned on verify), one active nonce per address (re-request replaces). The nonce itself is a UUIDv7 string.

**Step 1 — nonce:** `GET /api/auth/nonce?address=<base58>` → `200 {"nonce":"0192…-uuid-v7"}`; `400 "address is required"`; `403 web3_disabled` if your tenant has `solana_enabled:false` (or the deployment runs `SOLANA_ENABLED=false`; the route does not exist at all then — 404).

**Step 2 — sign.** The server checks only `strings.Contains(message, nonce)` — any human-readable message works. The reference client uses exactly:

```
Welcome to IPFPS.
To authenticate, please sign this message to verify your wallet ownership.
Nonce: 9f8d2c1a-....
```

i.e. template `` `${title}\n${desc}\nNonce: ${nonce}` ``. If the wallet supports `standard:signIn` (SIWS), pass `domain`, `statement="${title}\n${desc}"`, `uri`, `nonce` and sign the wallet-built SIWS message — that verifies too. Sign the exact bytes (ed25519 `signMessage`), base58-encode the 64-byte signature.

**Step 3 — verify:**

```
POST /api/auth/web3/verify
{"address":"AbCd…58","chain":"solana:mainnet","walletName":"Phantom",
 "message":"…Nonce: 9f8d2c1a-…","signature":"Base58Sig…","device_id":"web-1","language":"en"}
→ 200 {"token":"eyJ…","is_new_user":true}
```

| Field | Rules (enforced in `auth_web3.go`) |
|---|---|
| `address` | base58, decodes to 32 bytes (ed25519 pubkey); ≤100 chars |
| `chain` | must start with `solana` (`solana`, `solana:mainnet`, `solana-devnet`, …) |
| `message` | ≤500 chars, must contain the issued nonce verbatim |
| `signature` | base58, 64 bytes; ≤150 chars |
| `walletName`, `device_id`, `language` | free-ish strings, analytics only |

**Errors (verbatim):** `400 "invalid request format"` / `"input data exceeds size limits"` / `"invalid solana public key format"` / `"invalid signature format"` / `"unsupported blockchain network"`; `401 "invalid or expired authentication request. please try again"` (nonce burned/expired/re-requested) / `"message does not contain the required nonce payload"` / `"invalid cryptographic signature"`; `403 web3_disabled`; `409 "<wallet-link error text>"` (omnichannel link conflict — e.g. wallet already bound elsewhere).

**Omnichannel:** if the caller already presents a valid session JWT (in `Init-Data`) during verify, the wallet is **linked to the existing account** instead of logging in as the wallet identity; the response echoes the current token with `is_new_user:false`.

### 3.2 Local username and password

```
POST /api/auth/register   {"username":"player_one","password":"Str0ngPassw0rd","consent_terms":true,"consent_privacy":true,"language":"en"}
POST /api/auth/login      same body (username ≥3 chars; username OR email accepted)
→ 200 {"token":"eyJ…","is_new_user":true|false}
```

| Rule | Detail |
|---|---|
| username | `^[a-zA-Z0-9_.\-@]{3,254}$`; register needs ≥5 chars |
| username with `@` | **rejected at register**: `400 email_requires_magic` — email identities are created only via the magic flow (anti-account-takeover). Pre-existing email accounts log in normally |
| password | 8–72 chars (bcrypt limit) |
| consents | both must be `true` → else `400 consent_required`; journaled server-side (`terms`, `privacy`) |
| per-tenant | the same username in another tenant is a different account; login in a tenant without the credential → `401 invalid_credentials` |

Other codes: `400 invalid_username / weak_password`, `403 registration_disabled` (tenant flag or platform env `REGISTRATION_ENABLED=false`), `409 username_taken`. Auth bucket: ~5 attempts/min per IP (env-tunable).

### 3.3 Email magic link

```
POST /api/auth/magic/request   {"email":"player@example.com"}   → 200 {"ok":true}
POST /api/auth/magic/consume   {"token":"eyJ…"}                 → 200 {"token":"eyJ…session…"}
```

- Request is **always 200** on a syntactically valid email (`^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$`, ≤254 chars) — no account-existence oracle. Malformed → `400 invalid_email`. Bucket `magic` (0.5 rps / 10 burst per IP).
- The emailed link points at `{MINI_APP_URL}/auth/magic?token=…` (origin-exempt GET that 302-redirects to `{MINI_APP_URL}/?magic_token=<session JWT>`); in an SPA you usually forward the token to `/api/auth/magic/consume` instead.
- Link properties: one-time use (jti = challenge id, atomically redeemed), **15-minute** expiry, **latest-wins** (a newer request invalidates the old link). `401 invalid_or_expired_link` on bad/reused/expired. Identity owned by another global account → `409 identity_conflict`.
- Magic users have **no password**. `POST /api/user/set_password` `{"password","password2"}` works only when the account has a verified email credential in this tenant and no password yet: errors `400 password_already_set / weak_password / password_mismatch / password_requires_verified_email`.

### 3.4 Telegram mini app login

`POST /api/auth/tg {"init_data":"…"}` — init-data is standard Telegram WebApp data, HMAC-verified against **your tenant's** bot token (`apps.config.tg_bot_token`; empty → `503 tg_auth_disabled`, fail-closed). Extra freshness gate: `auth_date` within 24 h.

→ `200 {"token":"eyJ…","is_new_user":bool,"username":"tg_<id>","has_password":false}`. New Telegram identities get username `tg_<telegram_id>`; existing global accounts are SSO-linked into your tenant (welcome bonus only on the first-ever credential in the tenant). Consent is journaled as platform-attested. Errors: `400 bad_init_data`, `401 invalid_init_data`.

### 3.5 Wallet link and unlink

Verified routes in `services/iam/httpapi.go:96-98` (JWT):

| Method & path | Body / notes |
|---|---|
| `GET /api/user/wallets` | `→ {"wallets":[{id,address,chain,wallet_name,created_at}]}` |
| `POST /api/user/wallets/link` | `{"address":"<base58>","chain":"solana","wallet_name":"Phantom"}` → `{"status":"success"}`. Address must decode to a 32-byte ed25519 key (32–44 chars), `chain` must start with `solana`. `400 unsupported_chain / invalid_address`, `409 wallet_taken` (one owner per address globally). NB: linking here is trust-based; the *cryptographic* link path is web3 verify with a session (§3.1) |
| `DELETE /api/user/wallets/{id}` | → `{"status":"success"}`; `404 wallet_not_found` |

### 3.6 Discord OAuth, deployment gated

Routes exist only when the deployment wires Discord credentials (`DISCORD_CLIENT_ID/SECRET/REDIRECT_URI`) — otherwise they are absent entirely (404):

- `GET /api/auth/discord/login?state=<opt>` → `307` redirect to `https://discord.com/api/oauth2/authorize?…&scope=identify` (`state` passed through).
- `POST /api/auth/discord/verify` `{"code":"<authorization_code from the redirect>"}` → the standard session envelope `{"token","is_new_user"}`; with a live session JWT in `Init-Data` the Discord identity is SSO-linked to the existing account (omnichannel, §3.1). Errors: `400 "invalid request format or missing code"`.

---

## 4. Capability chapters

### 4.1 Money, ledger and holds

The ledger is currency-neutral: balances keyed `(app_slug, user_id, currency)`, arbitrary string codes (S2S-validated `^[A-Z0-9_]{2,32}$`), 8-decimal amounts, and a **`CHECK (amount >= 0)`** on every balance row. Consequences you can rely on:

- A debit that would overdraw **fails at the database constraint** — you get `409 insufficient_funds`, never a negative balance.
- The same code works uniformly across holds, settle_full, credits, shop prices and balance reads. Define `COINS`, `GEMS`, `TICKETS_v2` — no platform registration step.
- `credit` cannot forge provenance: `tx_type` is whitelisted to `^(credit|reward|game_win|adjustment)$` — a credit cannot masquerade as `deposit` (which would trigger XP/rev-share side effects).

**The settlement toolbox** — three primitives plus an atomic composite, all per-player, per-currency, idempotent:

| Primitive | Call | Semantics | Use for |
|---|---|---|---|
| hold | `POST /api/tenant/balance/hold` | Debit now, decide later. Funds leave the balance immediately — a hold is a held debit, so locked funds can never be spent twice. Returns `hold_id`; `round_id` (UUID) links the hold to your round for reconciliation | stakes, escrow, subscription reservation, lootbox spin |
| settle | `POST /api/tenant/balance/settle` `{hold_id}` | Capture: platform keeps the held funds; balance unchanged by settle itself. Idempotent; `409 lock_not_found` on unknown hold | house-risk rounds the player lost |
| release | `POST /api/tenant/balance/release` `{hold_id}` | Cancel: funds return with a reversal record. Repeat on a closed hold is a no-op | cancelled rounds, aborted wagers, refunds of unsettled stakes |
| settle_full | `POST /api/tenant/balance/settle_full` | No prior hold: atomic debit+credit in **ONE tx** (ledger `tx_type` `settle_debit`/`settle_credit`). If the debit leg exceeds the balance, **both legs roll back** — a half-settled state cannot exist. At least one leg >0 | instant per-round settle: payout = stake × multiplier |

Refund scenarios: either `release` the original hold, or `credit` with `tx_type:"adjustment"` (whitelist-safe) when no hold exists. Holds have **no TTL in v1** — they live until settled/released; release abandoned holds from your backend.

**Idempotency:** `hold`, `credit`, `settle_full` **require** `idempotency_key` (≤128 chars) → else `400 idempotency_key_required`. Same key + same payload → original result, funds move exactly once; same key + different payload → `409 idempotency_conflict`. Key scope is the **whole tenant** — one namespace for all your S2S calls; prefix keys yourself (`bet:…`, `payout:…`, `shop:…`). `settle`/`release` are idempotent by `hold_id` (repeat = no-op). `score` accepts an optional key; `referrals/link` dedups by the edge itself. Amounts ≤1e12 per call.

**Payments rails, in order of integration effort:**

1. **Internal-currency purchases** — the shop withdraw saga (§4.3) or S2S settle primitives above. No fiat involved.
2. **Crypto → balance → purchase** — player deposits USDC/SPL/SOL (§4.2), receives your internal currency, then buys. Zero extra code beyond the deposit flow.
3. **Fiat balance top-up** — `POST /api/wallet/deposit` (§5.1): fiat top-up via hosted Stripe Checkout (rolling out), atomic balance credit. **Availability is operator-confirmed at onboarding.** Client-sent intent fields are rejected (`400 "deposits are balance-only"`).
4. **Partner payments (S2S)** — your backend sells its own goods for real money via `POST /api/gateway/payments/create`, signed with your tenant S2S key pair (same headers as §5.2; the legacy `X-Gateway-Signature` + `GATEWAY_SECRET` + mandatory `app_slug` scheme is deprecated but still accepted — new integrations must use the tenant key):

```bash
BODY='{"external_payment_id":"order-12345","amount":500,"webhook_url":"https://api.yourgame.example/payments/ipfps","redirect_success_url":"https://yourgame.example/pay/ok","redirect_fail_url":"https://yourgame.example/pay/fail","is_test":false,"receipt_items":[]}'
# sign exactly like §5.2, POST $BASE/api/gateway/payments/create → {"payment_url":"…"}
```

`external_payment_id` is **your** order id — the outcome webhook echoes it back (fulfill idempotently by it). `amount` >0 USD; `receipt_items` must be a JSON array (`400 "invalid receipt_items json"` otherwise). No platform balance is deposited (`fulfill_mode=webhook`) — crediting goods is your webhook's job (§4.5). Errors: `401 invalid_signature` / `403 unknown_key` (tenant-key path), `400 "invalid request format or empty slug"`, `500 "payment gateway is not configured on this server"`.

**BYO merchant credentials (operator-onboarded):** `apps.config.payments` (operator-onboarded) routes your payments through your own Stripe account; self-service BYO is rolling out (§8). Secrets are masked in every public surface and read only by the payment service via trusted internal RPC. Hand creds to ops over an OOB channel. Note: BYO applies to app-owned intents; balance top-up and partner payments always ride the **platform** merchant account.

### 4.2 Deposits and multichain rails

**Model:** per-tenant escrow wallets. The player links a wallet, sends an accepted token to your escrow, a scanner (or a manual `deposit/verify`) credits your configured internal currency at a fixed published rate. Attribution is by `(chain, escrow)` — a transfer to *your* escrow credits *your* players in *your* currency.

**Token policy** (operator-only, but know the format): one `token_policies` row per token: `app_slug`, `chain` (`solana`), `token_symbol`, `token_address` (mint; **empty mint = native SOL**, and such a policy must carry `token_symbol:"SOL"`), `token_decimals`, `escrow_wallet`, `rate_to_internal` (1 token = N internal units), `min_deposit`/`max_deposit` (token units; out-of-range deposits are not credited), `internal_currency` (any ledger code). A brand-new mint additionally needs scanner registration (`SOLANA_SPL_MINTS`) — **tell ops to enable scanning before announcing the deposit address**; until then transfers to the escrow are not picked up. Native SOL needs no mint registration. Exposed to you read-only via `GET /api/deposit/config` (§5.1) — `tokens:[]` + zeroed top-level fields until a policy exists.

**Deposit flow:** player reads `deposit/config` → links wallet (`/api/user/wallets/link` or web3 verify) → transfers token to the per-token escrow → crediting happens on the scanner tick (< ~2 min target) or instantly via `POST /api/deposit/verify` → balance credited + WS `deposit_confirmed` + platform webhook `deposit.confirmed` (§4.5, with the v1 limitation: `chain`/`token_symbol` arrive as empty strings).

**Extended rails — capability statement, rolling out (no endpoints exist; do not build against them):**

- **EVM chains (Base, Arbitrum, Ethereum, BSC):** the per-tenant `token_policies` pattern carries over one-for-one — a policy row per token with `chain`, token `address` (instead of Solana mint), `chainId`, `decimals`, per-tenant escrow address, published `rate_to_internal`, `min_deposit`/`max_deposit` and `internal_currency`. Crediting rides the same scanner pattern (chain-indexer worker → idempotent `crypto.deposits` insert → ledger credit → WS `deposit_confirmed`), and `GET /api/deposit/config` will grow per-token chain fields when a rail activates. Wallet linking will follow the same trust-plus-crypto model as §3.1/§3.5.
- **TON:** same policy/scanner pattern; watch-only attribution by `(chain, escrow)`.
- **Tempo:** planned as an additional fiat-stable rail under the same deposit pipeline (policy → escrow/mint address → scanner → ledger).

Operational note for all rails: escrow/key custody and rail activation stay operator-only (§8), as with Solana today.

### 4.3 Shop and inventory

S2S-managed catalog (`/api/tenant/products*`), player-facing shop (`/api/shop/*`), sales export (`/api/tenant/purchases`). Player-facing routes are in §5.1; the catalog contract:

**SKU upsert** `PUT /api/tenant/products`:

```json
{"code":"theme_dark","title":"Dark theme","description":"…","price":100,"currency":"COINS",
 "image_url":"https://…/icon.png","sort_order":10,"kind":"digital","content_type":"application/json",
 "content":{"colors":{"bg":"#000"}}}
```

| Field | Rules |
|---|---|
| `code` | `^[a-z0-9_-]{1,50}$` — stable idempotent key; re-PUT updates in place (`status:"upserted"`, first = `"created"`). `is_active` is never touched by upsert |
| `title` | required, ≤255; `description` ≤4096 (else `400 invalid_title`) |
| `price` | >0, ≤1e12; `currency` `^[A-Z0-9_]{2,32}$`, default `WP` |
| `kind` | `digital` (default; requires non-empty `content`) \| `buff` (platform boosters, content ignored) |
| `content` | any JSON ≤512 KB (`400 content_too_large` / `content_required`); stored **opaque** — no interpretation, byte-for-byte delivery |
| `content_type` | ≤100 chars, becomes the download `Content-Type` (default `application/json`); `image_url` ≤1024 |

**Fulfillment semantics:** buy → item `pending_payment` → ledger debits the SKU price (`tx_type shop_buy`) → `active` (content **snapshot at activation time** — later catalog edits never change what buyers hold) or `rejected` (insufficient funds; never a buy-time error). Content is served only to the owner of an `active` item; everything else is masked `404`. Reconciliation: poll `GET /api/tenant/purchases` (rolling out: `purchase.completed` webhook, §8). Cancellations/refunds are your backend's job (S2S credit + revoke goods in your product).

### 4.4 Growth, referrals, seasons and tasks

**Referral graph.** The module is a **graph** (`social.referral_graph`: referrer→referred edges + `source` + date, per tenant, unique referred) — it does not move money by itself.

- **Linking:** player-side `POST /api/user/referrer` (§5.1) for self-serve invite links (`?ref=<user_id>`); server-side `POST /api/tenant/referrals/link` for your own invite program (both users must already exist in your tenant — provision with `POST /api/tenant/users` first). Pass a meaningful `source` (`my_launcher`, campaign tag…) — sources `web`/`tg`/`magic`/`vault_invite` are platform-set defaults.
- **Reading:** `GET /api/user/referrals` (player dashboard) and S2S `GET /api/tenant/referrals/{user_id}` (server view with `rewards_enabled`). Fields `total_rewarded`, `current_percent`, `next_tier` and per-referral deposit stats appear **only when the rewards engine is enabled** for your tenant.
- **Rev-share engine (opt-in, operator-only):** `app_settings.referral_config` `{"enabled":true, "tiers":[{"min_refs":N,"percent":P}…], "welcome":{"currency","amount","sources":[…]}}` — tiered % of your players' deposits paid to referrers + a per-edge welcome grant (ledger `tx_type referral_welcome`, restricted to configured sources). **Default OFF for every tenant** — without it the graph is pure statistics and you pay rewards yourself off the `referral.linked` webhook (§4.5) or by reading the graph.

**Leaderboards and scores** — polymorphic slices `(score_type, entity_type, season)` per tenant:

- **Write:** S2S `POST /api/tenant/score`. `points` is a signed delta (0 rejected). `score_type` (default `xp`) — any `^[a-z0-9_]{1,50}$` token: parallel independent boards (`arena_rating`, `event_points`, …). `entity_type` (default `user`) — anything else (`squad`, `guild`) makes the write a polymorphic entity row: `user_id` carries your entity id, no levels, no username resolution. `season` — empty = current UTC calendar month `YYYY_MM`; any custom string `^[A-Za-z0-9_-]{1,20}$` (your own seasons/events — rotation/reset is just starting a new string; the platform never deletes slices). `season_only:true` writes only the season slice (all_time untouched, levels never recomputed); otherwise every write also advances `all_time`.
- **Levels** move only when `entity_type=="user"` + `score_type` == your tenant's `leveling_source` (default `xp`/`all_time`, key in §6) + not `season_only`; level curve from `xp_curve_config`. `GET /api/tenant/score/{user_id} → level` follows the same source.
- **Read:** player-facing `GET /api/leaderboard` (JWT, `xp`/`user` slice only — **no** `score_type`/`entity_type` params; `season` param; `my_rank_info` on page 1) and S2S `GET /api/tenant/leaderboard` (any slice via `score_type`/`entity_type`, no my-rank). WS `leaderboard_update` pushes **all_time top-50 only** every ~10 s — poll the API for custom slices.

**Tasks, faucet, daily, activities** (player routes in §5.1): `GET /api/tasks` returns task templates merged with your progress (`onetime_claimed`, availability windows); `POST /api/tasks/{id}/verify` runs the server-side verifier and pays `reward_onetime` in your configured currencies. Faucet and daily-streak windows come from `/api/user/me → bonuses` (epoch ms) and are paid in the tenant-configured currencies (§6) — absent key = that reward is OFF for your tenant (fail-closed per tenant, no fallback chain).

### 4.5 Notifications

Two distinct per-tenant TG token mechanisms (do not confuse):

- **Auth:** `apps.config.tg_bot_token` — verifies mini-app init-data at `POST /api/auth/tg` (§3.4). Operator writes it (SQL into the tenant registry; self-service PATCH **strips** it); hot-reloaded; empty = fail-closed `503 tg_auth_disabled`.
- **Notify:** KV keys `<slug>_tg_client_bot_token`, `<slug>_tg_miniapp_url`, `<slug>_tg_welcome_text` — the platform long-polls **your** bot: every inbound message (incl. `/start <payload>`) gets your welcome text + an inline WebApp button; `telegram_join` tasks are verified with your bot via `getChatMember` (your bot must be in the target channel). **One poller per token — do not run your own `getUpdates` loop against the same bot** (409 conflicts). All operator-registered.

Other channels: **email** (magic link delivery, SMTP — working on contours with SMTP configured; Global-contour SMTP status is operator-dependent), **web push** (`/api/push/*`, §5.1 — implemented for the platform PWA; treat as best-effort for external tenants). There is **no tenant-facing notification-send API** — platform→player pushes happen via webhooks to your backend and via WS frames; tenant-branded TG messaging is the inbound-bot channel above.

**Outbound webhooks (platform → your backend).** Two channels; both `POST` JSON, at-least-once, **200-only success, 15 s timeout**, `NakWithDelay` retries **30 s → 2 min → 10 min → 1 h**, dead-lettered after **5 attempts** (contact support for replay). Verify HMAC over the exact raw body before acting.

1. **Platform event webhooks (v1).** Target: `apps.config.webhook_url` (self-service writable via PATCH; empty = off). Signed with your tenant S2S secret: `X-Tenant-Signature: hex(HMAC_SHA256(TENANT_S2S_SECRET, raw_body))`. Envelope `{"event","occurred_at" (RFC3339 UTC — dispatch time),"data"}` — **no tenant/slug field**. Dedup key: `data.event_id` (UUIDv7); ack duplicates `200`. Events:
   - `user.registered` — `{user_id, auth_provider, username (may be ""), event_id}`.
   - `deposit.confirmed` — `{user_id, currency, amount, tx_id, chain:"", token_symbol:"", event_id}` — v1 limitation: `chain`/`token_symbol` are **always empty strings**; treat deposits as currency-only.
   - `referral.linked` — `{referrer_id, referred_id, source, event_id}`.
   Requirements: a tenant with `webhook_url` but **no S2S key** gets a config warning and no deliveries (events are dropped). During key rotation keep both secrets valid on your verifier — see "Known doc drift" #1 about which secret signs during rotation.
2. **Partner payment webhooks.** Outcome of `POST /api/gateway/payments/create` (§4.1) POSTed to the per-payment `webhook_url`, signed with the **gateway secret** (unchanged by the S2S-key migration): `X-Gateway-Signature: hex(HMAC_SHA256(GATEWAY_SECRET, raw_body))`. Body: `{"external_payment_id":"order-12345","status":"success","amount":500}`. Only successful payments are pushed; `external_payment_id` is the only correlation field — fulfill idempotently by it. No platform balance is deposited.

### 4.6 Realtime websocket

**Connection.** `wss://{slug}.demo.ipfps.org/ws` — the edge routes `/ws` to the realtime hub on every tenant host, and the tenant is bound to the socket from the host/`Origin` at the gateway. The tenant never appears on the wire: no `app_slug` field in any frame. Auth = player JWT in the **`Init-Data` header of the upgrade request** (server-accepted fallback: `?auth=<token>` query param — this is the only option for in-browser `new WebSocket()`, which cannot set custom headers). No token → **guest** socket: it receives tenant-wide frames, but every mutating client event is dropped server-side. `Origin` is required (browsers send it automatically; bare clients set `Origin: https://{slug}.demo.ipfps.org` — it doubles as the tenant-resolution signal). Optional query params: `device_id`, `lang`, `client_env` (auto-attached to analytics).

**Frame format** both directions — one JSON text message:

```json
{"event":"<type>","data":{...}}
```

Server-side ids are UUIDv7 (`vault_message.id`, `balance_update.event_id`; `chat_message.id` is an int64 epoch-nanos) — dedup by them across reconnects where you re-apply state.

**Server → client** — every frame the hub actually emits, grouped by producer:

| Group | `event` | `data` (one line) |
|---|---|---|
| Balance | `balance_update` | targeted to the player's sockets: `{user_id, balances:{CUR:amt}, delta, currency, reason, target, event_id?}` — fires on every ledger movement (deposit, hold, settle, credit, shop debit) |
| Chat | `chat_history` | on connect: last ~50 lobby messages `[{id,userId,nickname,avatar,level,text,timestamp,isSystem,sysType?,sysArgs?}]` (camelCase on the wire; same shape as `GET /api/chat/history`) |
| Chat | `chat_message` | one new lobby message, same shape; tenant-wide fan-out |
| Chat | `chat_error` | `{reason}` — `too_long` / `no_links` / `server_busy` (answers your `chat_send_message`) |
| Feed | `live_feed_history` | on connect: ring of the last ≤10 big wins `[{nickname,amount,game,round_id}]` (skipped when empty or when the feed is off for your tenant) |
| Feed | `live_feed_win` | one new big win `{nickname,amount,game,round_id}`, tenant-wide |
| Leaderboard | `leaderboard_update` | ~every 10 s to the `leaderboard` room; all_time top-50 payload — poll `GET /api/leaderboard` for custom seasons |
| Vault messaging | `vault_message` | new encrypted message in a vault you belong to: `{id,vault_id,sender_id,reply_to_id?,edit_of_id?,encrypted_payload,created_at}` |
| Vault messaging | `vault_message_saved` | persisted copy, routed back to the sender |
| Vault messaging | `vault_message_pending` | optimistic ack to your `vault_send_message`: `{id,vault_id}` — map it onto your temp client id |
| Vault messaging | `vault_typing` | `{vault_id,user_id,nickname}` |
| Vault messaging | `vault_read_up_to` | `{vault_id,user_id,msg_id}` — a member moved their read cursor |
| Vault messaging | `vault_error` | `{reason}` — `unauthorized/invalid_payload/invalid_vault_id/empty_payload/access_denied/vault_resolution_failed/invalid_reply_to_id/invalid_edit_of_id/edit_check_failed/edit_not_allowed/server_busy` |
| Vault sync | `vault_file_confirmed` | upload confirmed (§4.7.1) |
| Vault sync | `vault_quota_changed` | drive quota changed (topup / set_quota) |
| Vault sync | `vault_item_deleted` | file/folder moved to trash |
| Vault sync | `vault_lease_expiring` | storage GB-lease expires soon |
| Vault sync | `vault_subscription_changed` | storage subscription changed |
| Games (built-in engines only) | `classic_tick` / `double_tick` / `hilo_tick` / `x50_tick` | engine state to the subscribed game room — the platform's own engines; **external tenants ignore** (the platform does not run your game loop — settle via S2S, §4.1) |
| Games | `bet_rejected` | targeted: `{amount,game,reason}` — `phase/min_bet/max_bet/insufficient_funds/invalid_tenant/invalid_bet` |
| Games | `game_error` | `{reason}` — e.g. games disabled |
| System | `xp_update` | `{user_id,delta_xp,current_xp,season_xp,old_level,new_level,rewards:[{level,reward_type,reward_value}],level_info?}` |
| System | `deposit_confirmed` | `{tx_hash,amount_wp,currency,token}` — crypto credit landed (`amount_wp` is a legacy key name; the value is denominated in `currency`) |
| System | `new_activity` | one inbox row `{id,user_id,actor_id?,actor_nickname?,type,target_id?,metadata,is_read,resolved_status?,created_at}` — mirror of `GET /api/user/activities` rows |
| System | `pong` | answers `ping`, echoes `data` |

**Client → server** — every inbound event the hub routes (guests may send only the first seven; everything below `log_out` requires a user token):

| `event` | `data` | Effect |
|---|---|---|
| `ping` | any | keep-alive → `pong` (echo); protocol-level WS ping/pong runs underneath |
| `subscribe` | room string `lobby\|classic\|double\|hilo\|x50\|leaderboard` | join a room — single-room model, re-subscribing moves you; unknown room → `lobby`; guest asking for `leaderboard` → forced to `lobby` |
| `page_view` | `{tab}` | analytics event `page_view` (device/env/user-agent auto-attached) |
| `auth_intent` | free-form map | analytics |
| `auth_error` | free-form map | analytics |
| `update_language` | `{lang}` | session language; authed users also persist it to their profile |
| `log_out` | — | analytics marker |
| `chat_send_message` | `{text}` | lobby post: ≤140 runes, URLs rejected → `chat_error`; persists and fans `chat_message` tenant-wide |
| `vault_send_message` | `{vault_id,encrypted_payload,reply_to_id?,edit_of_id?}` | encrypted vault message (§4.7.1); ack `vault_message_pending` or `vault_error`; vault role owner/editor/viewer required |
| `vault_typing` | `{vault_id}` | fans `vault_typing` to other members (2 s per-client throttle) |
| `vault_read_up_to` | `{vault_id,msg_id}` | persists read cursor, fans to members |
| `classic_place_bet` / `double_place_bet` / `hilo_place_bet` / `x50_place_bet` | engine payload | **built-in engines only — do not build on them** (§8) |

**Subscriptions & rooms.** Every connection is implicitly in its tenant lobby and receives tenant-wide frames (chat, feed) with no action. `subscribe` exists only for engine/leaderboard rooms and replaces your current room (one room per socket). Vault chats are *not* WS rooms: membership is data-driven through the Vault API (§4.7.1) — the hub fans vault frames to members automatically. The live feed is gated per-tenant: `apps.config.live_feed_enabled:false` stops both `live_feed_history` on connect and `live_feed_win` fan-out.

**Heartbeat & reconnection.** Send app-level `ping` on your own cadence (or rely on protocol ping/pong). On drop, reconnect with exponential backoff (base 1 s, ×2, cap 30 s, + jitter) and re-present the token: a fresh socket replays `chat_history` + `live_feed_history`, so treat them as idempotent sync points and dedup overlapping deltas by message id / `balance_update.event_id`.

**Smoke test:**

```bash
wscat -c "wss://my-game.demo.ipfps.org/ws" \
  -H "Origin: https://my-game.demo.ipfps.org" \
  -H "Init-Data: eyJhbGciOi…"
# ← {"event":"chat_history","data":[…]}   (plus live_feed_history when the ring is non-empty)
```

```js
// in-browser client — no deps (browser WebSocket can't set headers → ?auth= fallback)
const url = `wss://${slug}.demo.ipfps.org/ws?auth=${jwt}&device_id=web-1&lang=en`;
const ws  = new WebSocket(url);
ws.onmessage = (e) => {
  const { event, data } = JSON.parse(e.data);
  if (event === 'balance_update') renderBalances(data.balances);
  if (event === 'chat_message')   appendChat(data);
  if (event === 'deposit_confirmed') toast(`+${data.amount_wp} ${data.currency}`);
};
const send = (event, data) => ws.send(JSON.stringify({ event, data }));
send('ping');                      // → {"event":"pong",…}
send('subscribe', 'leaderboard');  // all_time top-50 pushes (~10 s)
send('chat_send_message', { text: 'gl hf' });
```

Custom WS channels for your own game ticks: rolling out (§8) — today you push game state over your own transport and use the platform frames for money/XP/chat/feed only.

### 4.7 Platform modules (white-label surfaces)

Modules that already exist in the platform and can be exposed under your brand. They are **platform-assisted**: nothing here is self-serve — ops enables the endpoints for your slug at onboarding (one email to support). Statuses are deployment facts.

**Vault & Files — Live · platform-assisted.** Encrypted drive storage, white-labeled: every player owns a personal drive; shared/P2P vaults with member roles (`owner`/`editor`/`viewer`); files live on S3-compatible object storage behind presigned URLs — two-phase upload (`upload_intent` → direct PUT to the presigned URL → `files` confirm) and presigned download; per-drive quota with GB-credit lease topups; the same storage backs chat file attachments and the vault messenger. Payloads are opaque ciphertext to the platform (`encrypted_payload` / `encrypted_dk` — client-side encryption model). Key player paths (enabled per tenant, full set §5.1): `GET /api/user/vaults` (my drives), `POST /api/vaults/{id}/upload_intent` → `{upload_url,data_key,session_id}`, `POST /api/vaults/{id}/files` (confirm → item id), `GET /api/items/{id}/download`. Quota breach → `507 {"error":"quota exceeded"}`. Realtime: the `vault_*` WS frames (§4.6 — messages, typing, read cursors, file/quota/subscription sync). **Access: platform-assisted** — ops enables `/api/vaults*` + `/api/items*` for your slug; `/api/messenger*` stays platform-product-only.

**Chat & Social — Live · platform-assisted.** Tenant-scoped public lobby chat: persisted per tenant in the vault domain, `chat_history` snapshot on WS connect plus the public REST fallback `GET /api/chat/history` (§5.1), posting via WS `chat_send_message` (§4.6 — 140 runes, URLs rejected), system rows (`sys_big_win`) interleaved with player messages. The social inbox ships with it: `GET /api/user/activities` (+ `/unread`, `POST /read`) and the targeted `new_activity` WS push. **Access: platform-assisted** — on for tenants by default; re-skin/disable per tenant via ops.

**Ticketing & Events — Live · platform-assisted.** A full event-ticketing domain runs behind the internal RPC `ticketing-service`: events, ticket issuance, QR entry (rotating short-lived QR JWT + 6-digit short-code fallback; admin scan/inspect/verify), payment-driven fulfilment (a successful payment auto-issues the ticket, idempotent by payment id, mail delivery included), sales stats. There is deliberately **no public tenant REST** — for event scenarios (festival passes, tournament entry, IRL quests) ops shapes a per-tenant BFF surface on request; money rides the standard rails (§4.1). **Access: platform-assisted** — capability call with support, endpoints enabled per tenant.

**Analytics (ClickHouse OLAP) — Live (ingest) · dashboards rolling out.** Clickstream lands in ClickHouse, not Postgres. Producers: the public beacon `POST /api/analytics/event` (§5.1), WS lifecycle events emitted by the hub itself (`app_open`/`app_close`/`page_view`/`auth_intent`/`auth_error`/`log_out`/`language_changed`), and server-side events — all durable over JetStream with UUIDv7 `trace_id` dedup, batched by analytics-sink (1000 rows / 3 s) into `analytics_events(trace_id,user_id,event_type,metadata,created_at)` (MergeTree, ordered by `(event_type, created_at)`). Reads are internal RPC (`analytics-service` counters/funnels) today; a self-serve per-tenant query/dashboard API is rolling out (§8). **Access: platform-assisted** — ingest Live; read API on request, self-serve rolling out.

---

## 5. API reference

How the public edge routes your requests (one edge per tenant hostname; you never address internal services directly):

| Path prefix | Handler |
|---|---|
| `/ws` | Realtime hub (§4.6) |
| `/api/auth/*`, `/auth/magic` | IAM auth (also `/api/user/wallets*`, `/api/user/set_password`, `/api/user/change_password`) |
| `/api/tenant/*` | **The gateway itself** — Tenant S2S API (§5.2); not proxied anywhere |
| `/api/gateway/payments/*`, `/payment/*`, `/webhooks/*` | Payments (economy): partner-payment create, provider callbacks |
| `/api/wallet/deposit` | Fiat top-up intent (economy) |
| `/api/deposit/*` | Crypto deposits (crypto-gateway) |
| `/api/shop/*`, `/api/user/*`, `/api/leaderboard`, `/api/tasks`, `/api/bonuses/*`, `/api/chat/*`, `/api/analytics/event` | Platform BFF (profiles, shop, referrals, tasks) |
| `/api/vaults*`, `/api/items*` | Vault & Files (vault service via edge path-upstream) — **platform-assisted** (§4.7) |
| `/api/tenant-host-check` | Demo-perimeter TLS probe (Caddy ask): `200 ok` / `404 unknown` — infra plumbing, not a tenant contract |
| everything else `/api/*` | Platform BFF |

`/api/vaults*` + `/api/items*` are the Vault & Files white-label module (§4.7.1) — reachable with a player JWT, but a tenant contract only when ops enables them for your slug. `/api/messenger*` remains a platform-internal product surface — do not build on it.

### 5.1 User facing endpoints

All endpoints require JWT in `Init-Data` + matching `Origin`, except those marked **public**. Default buckets: authenticated GETs `user_general` (10 rps/60), authenticated writes `user_action` (2 rps/20), shop buy & fiat deposit `buy` (1 rps/15) — full table in §5.3.

**Profile and settings:**

**`GET /api/user/me`** → the profile document (fields verbatim from `UserProfileResponse`):

```json
{
  "id": "018f…", "telegram_id": null,
  "username": "player_one", "nickname": "Player One", "photo_url": "",
  "balance_wp": 0, "balance_usd": 0,
  "balances": {"COINS": 100, "USD": 0},
  "language": "en", "notification_prefs": {"daily_reminder": false},
  "season_xp": 0, "current_season": "2026_10",
  "level_info": {"current_level":1,"current_xp":0,"level_start_xp":0,"next_level_xp":1000,"progress_percent":0},
  "bonuses": {"multiplier":1.0,
    "faucet":{"nextAvailableAt":0,"baseReward":100},
    "streak":{"currentDay":1,"nextAvailableAt":0,"expiresAt":0}},
  "level_rewards": [], "projects": [],
  "has_password": true, "is_ftue_completed": false
}
```

- **`balances` is the source of truth** — a currency→amount map of every currency the player holds in your tenant. `balance_wp`/`balance_usd` are legacy flat mirrors of the `WP`/`USD` entries (kept for old clients; prefer `balances`).
- `current_season` — platform season = UTC calendar month `YYYY_MM`. `level_info` is computed from lifetime XP of your tenant's leveling source (§4.4).
- `bonuses.faucet`/`streak` availability windows are epoch **ms**. `projects[]` = platform-app roles (usually empty for external tenants). `has_password:false` = magic/TG user who never set a password. `401 unauthorized` without token.

| Method & path | Contract |
|---|---|
| `PUT /api/user/nickname` | `{"nickname":"New Nick"}` — 3–15 runes, allowlist `^[\p{Latin}\p{Cyrillic}0-9_-]+( [\p{Latin}\p{Cyrillic}0-9_-]+)*$` (letters/digits, single spaces between words, `_`, `-`); else `400` with a descriptive message |
| `PUT /api/user/settings` | `{"language":"en","notification_prefs":{...}}` — language ∈ `en|ru|tt|zh` (others → `en`) |
| `POST /api/user/ftue_complete` | marks onboarding done → `{"status":"success"}` |

**Money reads:**

| Method & path | Contract |
|---|---|
| `GET /api/user/transactions?limit&offset` | limit default 20, max 100; `{"transactions":[{id,user_id,amount,currency,type,game_type,round_id,comment,metadata,created_at}],"has_more"}` (ISO-8601 `created_at`). Common `type` values: `deposit`, `bet`, `refund`, `faucet`, `daily_reward`, `welcome_bonus`, `referral_reward`, `level_up_reward`, `task_reward`, `purchase`, `shop_buy`, `credit`, `reward`, `game_win`, `adjustment`, `settle_debit`, `settle_credit` |
| `POST /api/wallet/deposit` | `{"amount":500,"description":"Top up"}` → `{"payment_url":"https://<provider>…"}` — redirect the browser there. Security invariant: any client-sent `intent_type`/`app_slug`/`event_id`/`intent_payload` → `400 "deposits are balance-only"`. Errors: `400 "invalid amount"` (≤0), `401 unauthorized`, `429 SLOW_DOWN` (buy bucket), `500 "payment gateway is not configured on this server"`, `503 payments_disabled`. After payment the provider calls the platform back; the balance is credited in one atomic tx and a `balance_update` WS frame is pushed. The provider redirect lands back on `{MINI_APP_URL}?payment=success\|fail` for the SPA to pick up. Fiat availability: operator-confirmed at onboarding — fiat rails are hosted Stripe Checkout with operator-onboarded keys (rolling out) (§4.1) |

**Leaderboard, referrals:**

| Method & path | Contract |
|---|---|
| `GET /api/leaderboard?season&limit&offset` (alias `GET /leaderboard`) | `season` default `all_time` (platform months `YYYY_MM` or any custom string — §4.4); `limit` default 50, max 100. → `{top_players:[{id,rank,name,avatar,score,level}], my_rank_info:{…} (page 1 only, else null), has_more}`. **No `score_type`/`entity_type` params** — always the `xp`/`user` slice; custom slices are S2S-only (§5.2) |
| `POST /api/user/referrer` | `{"referrer_id":"018f…","source":"<opt [a-z0-9_]{1,32}>"}` → `{"status":"success"}`. Codes: `400 "invalid referrer_id" / "invalid referrer_id format" / "invalid source" / "self-referral is not allowed"`, `409 "already linked"` (one referrer per player per tenant, ever). Invite convention: `?ref=<your user_id from /api/user/me>` |
| `GET /api/user/referrals` | the referral dashboard object **directly** (not wrapped): `{total_invited, total_rewarded:{<currency>:amount}, current_percent, next_tier?{min_refs,percent}, rewards_enabled, referrals:[{id,nickname,photo_url,total_deposited:{<currency>:amount},total_rewarded:{<currency>:amount},stats_by_currency:[{currency,total_deposited,total_rewarded}]}]}`. With the rewards engine OFF (`rewards_enabled:false`, the default): `total_rewarded` maps are empty, `current_percent` = 0, `next_tier` absent — graph fields are always present. §4.4 |

**Shop (player):**

| Method & path | Contract |
|---|---|
| `GET /api/shop/products?limit&offset` | Active showcase, **no content payload**. → `{products:[{id,code,title,description,price,currency,image_url,kind}],"has_more"}` (limit ≤200, default 50) |
| `POST /api/shop/buy` | `{"product_id":N,"idempotency_key":"<UUID>"}` (key must parse as a UUID — v7 recommended, fresh per attempt). → `200 {"item":{"id","product_id","status":"pending_payment"}}`. **Two-phase:** the ledger debit is async — insufficient funds is never a buy-time error; the item flips `pending_payment → active` (debited) or `→ rejected` (insufficient funds). Grant goods on `active` only; detect rejection by polling `/api/shop/inventory`. Same key replay returns the same item without double-debiting. Errors: `400 bad_request` (fields / non-UUID key), `404 not_found` (unknown/inactive SKU), `503 shop_unavailable`, `429 SLOW_DOWN` (buy bucket, `Retry-After: 3`) |
| `GET /api/shop/inventory?limit&offset` | → `{items:[{id,product_id,code,title,kind,content_type,status,purchased_at}]}` — no payload. `status` ∈ `pending_payment → active → rejected` |
| `GET /api/shop/inventory/{id}/content` | Raw content bytes, SKU's `content_type` (default `application/json`), `X-Content-Type-Options: nosniff`. Owner of an **active** item only — anything else is masked `404 not_found` (never 403); non-digital item → `409 not_digital` |

**Crypto deposits (player):**

| Method & path | Contract |
|---|---|
| `GET /api/deposit/config` — **public** | Per-tenant token policies: `{chain, escrow_wallet, rate, min_deposit, max_deposit, tokens:[{symbol, mint, decimals, chain, escrow_wallet, rate, min_deposit, max_deposit, internal_currency}]}`. Top-level fields are legacy mirrors of the first policy entry — prefer per-token fields. `tokens:[]` until ops registers a policy for your tenant (top-level `chain` still names the platform default chain; the other top-level fields are zeroed/empty). §4.2 |
| `POST /api/deposit/verify` | `{"signature":"<base58 tx sig>","chain":"solana"}` — manual crediting ahead of the scanner tick. `200 {"status":"success","amount_token":10.0,"amount_wp":10000,"currency":"COINS","token":"USDC","tx_hash":"…"}` (`amount_wp` is a legacy key name — the value is in `currency`, not necessarily WP). `403 wallet_not_linked` (sender not linked to this account) / `sender_not_owned` (sender linked to another user); `422 <validation message>` (not the accepted token, wrong escrow, out of range); `502 processing_failed` (upstream crediting error — safe to retry); `503 escrow_unavailable` |
| `GET /api/deposit/history?limit&offset` | limit default 20, max 200 → `{deposits:[{id,chain,tx_hash,token_symbol,amount_token,credited_currency,amount_wp,exchange_rate,created_at}], limit, offset}`. On success the player also receives a WS `deposit_confirmed` frame (§4.6) |

**Tasks, bonuses, activities, misc:**

| Method & path | Contract |
|---|---|
| `GET /api/tasks` (`X-Client-Env: browser` header or `?client_env=`) | → `{status,tasks:[TaskItem],multiplier}` — TaskItem = task template + your progress: `{id (uuid),task_type,category,config,reward_mult,reward_onetime:[{type,value,currency?}],platforms,required_account,title_key,desc_key,icon,is_active,sort_order,availability,onetime_claimed}` |
| `POST /api/tasks/{id}/verify` | → `{status:"success",task:<TaskItem with fresh progress>,multiplier}`; failure `400` with the verifier message |
| `POST /api/bonuses/faucet/claim` | → `{status:"success",reward,nextAvailableAt (epoch ms)}`; during cooldown `400` with remaining wait in the message. Reward currency/cooldown are tenant-configured (§6) |
| `POST /api/bonuses/daily/claim` | → `{status:"success",streak,reward:{day_number,reward_type,reward_value},nextAvailableAt,expiresAt (epoch ms)}`; availability in `/api/user/me → bonuses.streak` |
| `GET /api/user/activities?limit&before_id=` | limit ≤100, default 50; cursor paging by `before_id`. Rows: `{id,user_id,actor_id?,actor_nickname?,type,target_id?,metadata,is_read,resolved_status?,created_at}`. `GET /api/user/activities/unread` → `{unread_count}`; `POST /api/user/activities/read` marks all read (`{"status":"ok"}`) |
| `POST /api/push/subscribe` / `POST /api/push/unsubscribe` | Web Push subscription objects `{endpoint,p256dh,auth,device_id?}` (all but device_id required) / `{endpoint}`. Status: implemented for the platform PWA; for external tenants treat as best-effort/operator-dependent |
| `GET /api/chat/history` — **public** | Vault-backed lobby chat, also delivered as WS `chat_history` on connect. `?limit` default 50, max 100 → `{messages:[{id,userId,nickname,avatar,level,text,timestamp (epoch ms),isSystem,sysType?,sysArgs?}]}` (camelCase on the wire, same shape as the WS frame) |
| `POST /api/analytics/event` — **public** beacon | Body `{"type","meta"}` (**not** `event_type`/`metadata`). `type` must match `^[a-z][a-z0-9_]{2,49}$` **and** be on the platform whitelist — today the whitelist carries only platform-app events (`afro_*`), so external tenants cannot inject custom types (operator-dependent). `meta` ≤1024 bytes; `user_agent`/`client_env` (header `X-Client-Env`)/`platform` (header `X-Platform`) auto-attached. JWT optional (attributes the event). → `{"ok":true}`; `400 "invalid body" / "invalid type" / "meta too large"` |

**Platform-assisted module surfaces** (§4.7) — player JWT + Origin; enabled per tenant by ops:

| Method & path | Contract |
|---|---|
| `GET /api/user/vaults` | my drives/vaults (personal + shared memberships) |
| `POST /api/vaults` / `POST /api/vaults/{id}/invite` / `POST /api/vaults/resolve` | create P2P/shared vault; invite a member; resolve a share link |
| `GET /api/vaults/{id}/items` / `GET /api/vaults/{id}/trash` | list items / trash (role owner/editor/viewer) |
| `POST /api/vaults/{id}/upload_intent` | `{size_bytes,parent_id?}` → `{upload_url,data_key,session_id}` — presigned direct upload; over quota → `507 {"error":"quota exceeded"}` |
| `POST /api/vaults/{id}/files` | confirm `{session_id,name,size_bytes,encrypted_dk,thumbnail_b64?}` → `{id}`; members get `vault_file_confirmed` |
| `GET /api/items/{id}` / `GET /api/items/{id}/download` | metadata / presigned download (member only) |
| `DELETE /api/items/{id}` (+ `POST /api/items/{id}/restore`, `DELETE /api/items/{id}/permanent`) | trash / restore / purge; fires `vault_item_deleted` |

### 5.2 Tenant S2S endpoints

Base: `https://{slug}.demo.ipfps.org/api/tenant/*` (or your tenant origin). HTTPS only, JSON. **No JWT, no Origin** — the gateway handles these paths itself.

**Authentication & signing.** Every request carries:

```http
X-Tenant-Key-Id: k_01J…                 # identifies the key (rotation)
X-Tenant-Signature: hex(HMAC_SHA256(SECRET, raw_request_body))
```

- Sign the **exact raw body bytes**. GET requests sign the **empty string** (all GETs here are body-less).
- Missing headers or HMAC mismatch → `401 {"error":"invalid_signature"}` (constant-time compare). Unknown/revoked `key_id` → `403 {"error":"unknown_key"}` — revocation is live (KV key store), no restarts.
- **Slug pinning:** your tenant is pinned server-side from the key. An explicit foreign `app_slug` in a body → `403 slug_mismatch`. Never send or store slugs. (Exception: `POST /api/gateway/payments/create` accepts-and-ignores `app_slug` — legacy compatibility.)
- Rate: dedicated `tenant_s2s` bucket — **10 rps / burst 60 per tenant slug**, enforced after signature verification. `429 SLOW_DOWN` + `Retry-After`.
- Max body 1 MB.

```bash
# bash + openssl
BODY='{"user_id":"018f…","currency":"COINS","amount":1000,"tx_type":"credit","comment":"QA","idempotency_key":"qa-0001"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -X POST "$BASE/api/tenant/balance/credit" -H "X-Tenant-Key-Id: $KEY_ID" \
  -H "X-Tenant-Signature: $SIG" -H 'Content-Type: application/json' -d "$BODY"
# GET (empty body):  SIG=$(printf '' | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
```

```python
# python3
import hashlib, hmac, json, urllib.request
body = json.dumps({...}).encode()          # sign the EXACT bytes you send
sig = hmac.new(bytes.fromhex(SECRET), body, hashlib.sha256).hexdigest()
req = urllib.request.Request(f"{BASE}/api/tenant/balance/credit", data=body, method="POST",
    headers={"Content-Type":"application/json","X-Tenant-Key-Id":KEY_ID,"X-Tenant-Signature":sig})
```

```js
// node (built-in crypto/fetch, no deps)
import { createHmac } from 'node:crypto';
const sig = createHmac('sha256', SECRET).update(body).digest('hex');   // body = JSON.stringify({...})
const res = await fetch(`${BASE}/api/tenant/balance/credit`, { method:'POST',
  headers:{'Content-Type':'application/json','X-Tenant-Key-Id':KEY_ID,'X-Tenant-Signature':sig}, body });
```

**User masking rule** for every `{user_id}` path: unknown UUID and another tenant's player are **indistinguishable** — both `404 user_not_found`. Membership = any credential in your tenant.

| # | Method & path | Body → Response | Notes / errors |
|---|---|---|---|
| 1 | `POST /api/tenant/introspect` | `{"token"}` → `200 {"valid":true,"user_id","auth_provider","expires_at"}` | Bad/expired token → `200 {"valid":false}` (never 401). Token of another tenant → `403 slug_mismatch`. No slug echoed |
| 2 | `POST /api/tenant/users` | `{username` xor `email, password?, language?, app_slug?}` → `200 {"user_id","status":"created"\|"existing","has_password"}` | Admin provisioning; idempotent by identifier; **no welcome bonus**; consent journaled as `tenant_attested` (email credential counts as verified → `set_password` allowed) |
| 3 | `GET /api/tenant/users/{user_id}` | → `{"user_id","username" ("" for web3/TG-only),"created_at","has_password"}` | |
| 4 | `GET /api/tenant/users/lookup?username=` \| `?email=` | → `{"user_id","username"}` | Exactly one param (both/neither → `400 invalid_request`); email ≤254 + contains `@`; miss → `404 user_not_found` |
| 5 | `GET /api/tenant/balance/{user_id}` | → `{"user_id","balances":{"COINS":1250.5,"USD":0}}` | All currencies; empty map when no balances |
| 6 | `POST /api/tenant/balance/hold` | `{"user_id","currency","amount","idempotency_key","round_id"?}` → `{"hold_id","balance_after"}` | Funds **debited immediately** (§4.1). `409 insufficient_funds`; currency `^[A-Z0-9_]{2,32}$`; amount ≤1e12 |
| 7 | `POST /api/tenant/balance/settle` | `{"hold_id"}` → `{"ok":true}` | Captures the hold; idempotent; `409 lock_not_found` |
| 8 | `POST /api/tenant/balance/release` | `{"hold_id"}` → `{"ok":true}` | Cancels, returns funds (credit + reversal record). Repeat on closed hold = no-op |
| 9 | `POST /api/tenant/balance/credit` | `{"user_id","currency","amount","tx_type"?,"comment"?,"idempotency_key"}` → `{"user_id","currency","balance_after"}` | `tx_type` whitelist `^(credit\|reward\|game_win\|adjustment)$` (default `credit`) → else `400 invalid_tx_type`. `comment` ≤512. `400 invalid_currency / invalid_amount`; `404 user_not_found` |
| 10 | `POST /api/tenant/balance/settle_full` | `{"user_id","currency","debit_amount","credit_amount","idempotency_key","round_id"?}` → `{"user_id","currency","balance_after"}` | Atomic two-leg in ONE tx (insufficient funds rolls back BOTH legs). At least one leg >0. Ledger `tx_type` `settle_debit`/`settle_credit` |
| 11 | `GET /api/tenant/transactions/{user_id}?limit&offset` | → `{"transactions":[{id,type,currency,amount,comment,created_at}],"has_more"}` | limit ≤200, default 50; newest first |
| 12 | `GET /api/tenant/payments?limit` | → `{"payments":[{id,amount,currency,status,external_payment_id,created_at}]}` | Your tenant's fiat payment rows; limit ≤200, default 50. `currency` effective (legacy NULL → `USD`) |
| 13 | `POST /api/tenant/score` | `{"user_id","points" (signed ≠0),"reason"?,"idempotency_key"?,"season"?,"score_type"?,"entity_type"?,"season_only"?}` → `{"user_id","applied","global_xp","season_xp","old_level","new_level","season"}` | `score_type`/`entity_type` `^[a-z0-9_]{1,50}$` (defaults `xp`/`user`; else `400 invalid_score_type / invalid_entity_type`). Semantics in §4.4 |
| 14 | `GET /api/tenant/score/{user_id}?season&score_type` | → `{"user_id","global_xp","season_xp","level","season","score_type"}` | season empty → current calendar month; `level` per your tenant's leveling source (0 when no rows) |
| 15 | `GET /api/tenant/leaderboard?season&limit&offset&score_type&entity_type` | → `{"season","score_type","entity_type","entries":[{rank,user_id,username,value}],"has_more"}` | season empty → `all_time`; limit ≤100, default 50; `score_type`/`entity_type` echo effective values — cache by the echo. `username` falls back to nickname → `""` |
| 16 | `GET /api/tenant/referrals/{user_id}` | → `{"user_id","referrer_id" (null),"total_invited","rewards_enabled","referrals":[{user_id,username,source,created_at}]}` | `rewards_enabled` = your tenant's `app_settings.referral_config` opt-in (default false) |
| 17 | `POST /api/tenant/referrals/link` | `{"referrer_id","referred_id","source"?,"idempotency_key"?}` → `{"status":"linked"\|"already_linked"}` | Both users must be yours (`404 user_not_found` masked). `referrer==referred` → `400 self_link`; `source` `^[a-z0-9_]{1,32}$`. Idempotency IS the edge (unique referred per tenant); `referral_linked` event fires once, on creation |
| 18 | `PUT /api/tenant/products` | SKU upsert → `{"product_id":N,"status":"created"\|"upserted"}` | Full contract in §4.3 |
| 19 | `GET /api/tenant/products?limit&offset` | → `{"products":[…],"has_more"}` | Full catalog incl. inactive **with content** (limit ≤200, default 50) — the only payload-returning list |
| 20 | `POST /api/tenant/products/{code}/activate` | → `{"code","is_active":true}` | Unknown code → `404 not_found` |
| 21 | `POST /api/tenant/products/{code}/deactivate` | → `{"code","is_active":false}` | |
| 22 | `GET /api/tenant/purchases?limit&offset&user_id=` | → `{"purchases":[{id,user_id,product_id,product_code,product_title,status,purchased_at}],"has_more"}` | Your sales export, newest first; `user_id` filter optional (foreign UUID → `404 user_not_found` masked) |

**S2S error codes (verbatim):**

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_request` | Malformed body/fields, bad uuid in path |
| 400 | `invalid_request` | Semantic validation (zero amounts, both lookup params, bad source, comment >512, …) |
| 400 | `invalid_currency` | Outside `^[A-Z0-9_]{2,32}$` |
| 400 | `invalid_amount` | ≤0 / negative leg / >1e12 |
| 400 | `invalid_tx_type` | credit tx_type outside the whitelist |
| 400 | `invalid_score_type` / `invalid_entity_type` | Format violation `^[a-z0-9_]{1,50}$` |
| 400 | `self_link` | referrals/link referrer == referred |
| 400 | `idempotency_key_required` | hold / credit / settle_full without a key |
| 401 | `invalid_signature` | HMAC mismatch or missing signature/key-id headers |
| 403 | `unknown_key` | Unknown or revoked `key_id` |
| 403 | `slug_mismatch` | Explicit foreign `app_slug` in the body |
| 404 | `user_not_found` | Unknown or foreign user id (indistinguishable by design) |
| 404 | `not_found` | Unknown S2S path / unknown SKU |
| 409 | `insufficient_funds` | Hold/settle debit exceeds balance (settle_full rolls back both legs) |
| 409 | `lock_not_found` | Settle/release on unknown hold |
| 409 | `idempotency_conflict` | Key reused with a different payload |
| 429 | `SLOW_DOWN` (+`retry_after`, `Retry-After` header) | tenant_s2s quota |
| 503 | `upstream_unavailable` | Internal service unreachable — retry |

### 5.3 Rate limit buckets

Token bucket, per tenant + per principal. HMAC-signed paths bypass JWT buckets; `/api/tenant/*` enforces `tenant_s2s` after signature verification.

| Bucket | Applies to | Rate | Burst |
|---|---|---|---|
| `guest` | all unauthenticated traffic | 3 rps | 40 / IP |
| `auth` | login + register | 0.083 rps | 5 / IP (~5/min — brute-force gate) |
| `magic` | magic request/consume | 0.5 rps | 10 / IP |
| `analytics` | `POST /api/analytics/event` | 0.5 rps | 10 / IP |
| `user_general` | authenticated GETs | 10 rps | 60 / user |
| `user_action` | authenticated writes (default) | 2 rps | 20 / user |
| `buy` | `POST /api/shop/buy`, `POST /api/wallet/deposit` | 1 rps | 15 / user |
| `tenant_create` | `POST /api/tenants` | 0.1 rps | 2 / user |
| `tenant_s2s` | all `/api/tenant/*` | 10 rps | 60 / tenant slug |

On 429: honor `Retry-After` (seconds); exponential backoff with jitter on 429/5xx (base 1 s, ×2, cap 30 s); never blind-retry non-idempotent writes. Body shape: most 429s return `{"code":"SLOW_DOWN","error":"<localized string>","retry_after":N}`; the IAM `tenant_create` 429 returns plain `{"error":"SLOW_DOWN"}` with only the `Retry-After` header.

**Other limits:** JSON body ≤1 MB; usernames 5–254 (register) / 3–254 (login); password 8–72; web3 address/signature/message = 100/150/500 chars; pagination — transactions/leaderboard/activities max 100, deposit history max 200, shop/S2S lists max 200; chat ≤140 runes, no URLs; S2S `idempotency_key` ≤128.

### 5.4 Error codes (common)

| HTTP | `error` | Where / meaning |
|---|---|---|
| 400 | `invalid request format` | any POST — malformed JSON |
| 400 | `consent_required` / `invalid_username` / `weak_password` / `email_requires_magic` | register/login (§3.2) |
| 400 | `password_mismatch` / `password_already_set` / `no_password_set` / `password_requires_verified_email` | password management |
| 400 | `invalid_email` | magic request |
| 400 | `deposits are balance-only` / `invalid amount` | `/api/wallet/deposit` |
| 400 | `bad_init_data` / 401 `invalid_init_data` / 503 `tg_auth_disabled` | TG auth |
| 401 | `unauthorized` | missing/invalid session **or** missing Origin on non-public paths |
| 401 | `tenant_mismatch` | token minted for a different tenant used on this origin |
| 401 | `invalid_credentials` | login (per-tenant pair miss) / wrong old password |
| 401 | `invalid or expired authentication request. please try again` / `message does not contain the required nonce payload` / `invalid cryptographic signature` | web3 verify |
| 401 | `invalid_or_expired_link` / 409 `identity_conflict` | magic consume |
| 403 | `registration_disabled` / `web3_disabled` | per-tenant flags |
| 403 | `wallet_not_linked` / `sender_not_owned` | deposit verify |
| 404 | `user not found` | `/api/user/me` — deleted user |
| 409 | `username_taken` / `wallet_taken` / `already linked` / `self-referral is not allowed` | register / wallet link / referrer |
| 400 | `invalid body` / `invalid type` / `meta too large` | analytics beacon (§5.1) |
| 422 | `<validation message>` | deposit verify — bad token/escrow/range |
| 429 | `SLOW_DOWN` (+ `code`, `retry_after`, `Retry-After` header) | any bucket |
| 502 | `processing_failed` | deposit verify — upstream crediting error (safe to retry) |
| 500 | `payment gateway is not configured on this server` | payments/create without provider |
| 503 | `payments_disabled` / `escrow_unavailable` / `shop_unavailable` / `upstream_unavailable` | provider/escrow/commerce/upstream down — retry |

S2S-specific codes: table in §5.2. Shop codes: `bad_request`, `not_found`, `not_digital`, `shop_unavailable`, and catalog validation codes `invalid_code / invalid_title / invalid_price / invalid_currency / invalid_kind / content_required / content_too_large` (all 400). Unknown codes: log and treat as retryable only for idempotent requests.

---

## 6. Config reference

`apps.config` — per-tenant registry record; jsonb merge on PATCH; published to the platform KV bus — **all changes hot-reload, no restarts anywhere**:

| Key | Type | Effect / access |
|---|---|---|
| `registration_enabled` | bool | `false` → register closed for your tenant (`403 registration_disabled`). Default open (platform env is the master switch) |
| `solana_enabled` | bool | `false` → web3 nonce/verify disabled (`403 web3_disabled`). Alias: `web3_enabled` (read only when `solana_enabled` absent) |
| `welcome` | `{currency, amount}` | Welcome bonus. Resolution: explicit `welcome.currency` → `currencies[0]` → `WP`. amount=0 = off. Valid welcome also writes `app_settings.welcome_bonus_currency` |
| `currencies` | string[] | Your currency registry; `[0]` = primary (welcome default). Informational — the ledger accepts any code |
| `features` | free-form JSON | Opaque storage returned to you; the platform does not interpret it |
| `cors_origins` | string[] | Extra allowed origins, exact `scheme://host[:port]` (https/http-dev/chrome-extension; lowercase; no wildcards, no suffix match; default ports normalized). For frontends outside your tenant hosts (Vercel, extensions) |
| `webhook_url` | string | Target of platform event webhooks (§4.5); empty = off |
| `live_feed_enabled` | bool | `false` kills the live feed for your tenant (§4.6). Absent = on |
| `magic_enabled`, `require_email_verification` | bool | Reserved (not enforced today) |
| `tg_bot_token` | string | **Operator-only** — TG mini-app auth (§3.4, §4.5); stripped from self-service PATCH |
| `payments` | object | **Operator-only** — BYO merchant credentials (§4.1); stripped from self-service PATCH; secrets masked in all public surfaces |

`app_settings` — per-tenant economics, read **fail-closed per tenant** (`Manager.RawForTenant(slug)`, no fallback chain): if a key is absent for your tenant, that reward type is OFF (platform defaults apply only to the platform tenant).

| `app_settings` key | Effect |
|---|---|
| `welcome_bonus_currency` (+ `apps.config.welcome {currency,amount}`) | Welcome bonus on first registration. Self-service: PATCH `welcome` (amount>0 requires currency `^[A-Z0-9_]{2,32}$`, else `400 invalid_welcome`; amount=0 deletes the key = welcome off). Effective immediately |
| `faucet_currency` + `faucet_config` | Faucet reward currency + `{base_reward, cooldown_min}` (platform defaults 100/60 min when configured) |
| `daily_reward_currency` + `daily_rewards_config` | Daily-streak reward currency + per-day table |
| `level_reward_currency` + `level_rewards_config` + `xp_curve_config` | Level-up reward currency, reward table, level curve `{early_levels, base, exponent, max_level}` |
| `games_currency` | Currency of the platform's built-in game engines — irrelevant for external tenants |
| `xp_rules_config` | Ledger→XP conversion `{tx_type: {currency: multiplier}}` (flat or `{"rules":{…}}`). **Absent for external tenants = zero ledger XP.** tx_types: `deposit`, `bet`, `withdraw`, `refund`, `faucet`, `daily_reward`, `welcome_bonus`, `referral_reward`, `level_up_reward`, `task_reward`. `{}` = deliberately disabled |
| `leveling_source` | `{"score_type","season"}` — which score slice feeds levels (default `xp`/`all_time`), §4.4 |
| `referral_config` | Referral rewards engine opt-in, §4.4 |

All `*_currency` keys beyond `welcome_bonus_currency` are **operator-set** (SQL into `app_settings` for your slug; hot-reloaded). Self-serve covers only the welcome bonus.

---

## 7. Recipes

### 7.1 Web3 game with stakes (hold → settle)

1. Player logs in via Solana (§3.1); your backend identifies them by `user_id` (introspect the JWT, §5.2 #1).
2. Player places a bet → S2S `balance/hold` `{amount: stake, currency, idempotency_key: "bet:<roundUUID>", round_id}` → keep `hold_id` with the round state.
3. Round resolves: player lost → `balance/settle {hold_id}`; round cancelled → `balance/release {hold_id}`; payout needed → `settle_full {debit_amount:0, credit_amount: winnings, idempotency_key: "payout:<roundUUID>", round_id}` (or settle the hold + settle_full the winnings).
4. Push the new balance to the player's UI from your game state, or let the platform's `balance_update` WS frame reflect the release/credit.

### 7.2 Skin shop in your internal currency

1. PATCH config: `welcome {currency:"COINS",amount:100}` (self-service) + ask ops for `faucet_currency:"COINS"` if you want a faucet.
2. S2S `PUT /api/tenant/products` per SKU (price in COINS, `kind:"digital"`, small JSON `content` = skin descriptor) → `POST .../activate`.
3. Frontend: `GET /api/shop/products` grid → `POST /api/shop/buy` → poll `GET /api/shop/inventory` until `status:"active"` → grant the skin in your game (download content if the skin data lives in the SKU).

### 7.3 Selling JSON/digital goods for USDC

1. Ops registers a USDC token policy crediting `COINS` (§4.2 format) — one email; no code.
2. Player: link wallet → read `deposit/config` → send USDC to the shown escrow → poll `/api/deposit/history` or wait for the `deposit_confirmed` WS frame.
3. Then the normal shop flow (§7.2) — the currency is the same ledger COINS.

### 7.4 Telegram mini-app

1. Give ops your BotFather token + mini-app URL (§4.5). Wait for confirmation.
2. In the mini-app, read `window.Telegram.WebApp.initData` → `POST /api/auth/tg` → store the returned JWT; all further calls use `Init-Data`.
3. `is_new_user:true` → show onboarding; `has_password:false` → optionally offer `set_password` for cross-device login.

### 7.5 Extension or SPA with a leaderboard

1. Host wherever you like; PATCH `cors_origins:["https://your-app.example"]` (or `chrome-extension://<id>`).
2. After each game event, S2S `POST /api/tenant/score {points, reason}` (default xp/user slice moves levels too).
3. Frontend renders `GET /api/leaderboard?season=all_time`; for a seasonal event pass `season:"halloween_2026"` on writes and reads. Squad ratings: `entity_type:"squad"` + `user_id:<squad uuid>` on writes, S2S board read for display.

### 7.6 Referral mechanic (bring-your-own rewards)

1. Player A shares `https://you/?ref=<A user_id>`; on first load the app calls `POST /api/user/referrer {referrer_id}` for player B.
2. Stand up a webhook receiver, set `webhook_url` via PATCH, verify `X-Tenant-Signature` (S2S secret).
3. On `referral.linked` → credit the referrer via S2S `balance/credit {tx_type:"reward", comment:"referral"}` — your own reward size, your own rules. (Or ask ops to enable the tiered `referral_config` engine instead.)

### 7.7 Seasonal event (season scores)

1. Pick a string `s9_2026`. During the event, write scores with `season:"s9_2026"` (+`season_only:true` if lifetime boards must not move).
2. Read back: S2S `GET /api/tenant/leaderboard?season=s9_2026` (any slice) or player-facing `GET /api/leaderboard?season=s9_2026` (xp/user only).
3. End of event: stop writing; the slice stays readable forever. No reset job needed — next season is a new string.

### 7.8 Deposits with a custom SPL token

1. Send ops: mint, decimals, symbol, `rate_to_internal`, min/max, `internal_currency` (+ remind them to register the mint in the scanner config).
2. `GET /api/deposit/config` now lists your token → surface the escrow address in your UI → the standard deposit flow (§4.2).

### 7.9 Refunds and cancellations

- Held but unplayed stake → `balance/release {hold_id}` (instant reversal).
- Already-settled loss you want to refund → `balance/credit {tx_type:"adjustment", comment:"refund:…"}` + revoke goods in your product.
- Rejected shop purchase → nothing to do; the funds were never moved. If you took the goods anyway, credit manually.

### 7.10 Webhook automation (CRM sync)

Set `webhook_url` to your receiver; verify `X-Tenant-Signature` with the S2S secret; dedupe by `data.event_id`; answer `200` fast and process async; on non-200 the platform retries 30s→2m→10m→1h then DLQs (5 attempts) — replay via support.

---

## 8. Operator only and rolling out

Not self-service — one email to support@ipfps.org:

| Item | Why operator-only |
|---|---|
| Crypto token policies / escrow wallets + scanner mint registration | Funds custody; dedicated escrow per (tenant, token) |
| BYO payment merchant credentials (`payments` block) + `GATEWAY_SECRET` lifecycle | Secret custody; masked everywhere |
| Tenant TG bot token (+ notify KV keys, mini-app URL, join-task channel) | Secret custody |
| DNS / custom domains / static hosting of your `dist/` / dedicated backend VM / egress allowlists | Edge & infra |
| `app_settings` economics beyond `welcome_bonus_currency` (faucet/daily/level/games currencies, XP rules, curves, rewards, `leveling_source`) | Tenant-wide money effects; SQL-applied, hot-reloaded |
| Referral rev-share opt-in (`referral_config`) | Money movement engine |
| Webhook DLQ replay, rate-bucket raises, fiat provider enablement per contour | Platform ops |

**Rolling out (capability statements — no endpoints exist yet):** EVM/TON/Tempo deposit rails (§4.2 — same policy/scanner pattern, same `deposit/config` shape); Stripe card acquiring on the payments-intent pipeline with per-tenant merchant creds (§4.1); additional webhooks `purchase.completed` / `score.applied` / `referral.first_deposit`; custom WS channels for game ticks (§4.6); self-service `payments` / `tg_bot_token` management APIs; analytics self-serve beyond the beacon (custom `type` whitelist entries today are operator-dependent, §5.1).

**Live capability snapshot:** S2S API (22 endpoints) ✅ · self-service tenants + keys + config ✅ · auth (local/magic/web3/TG/Discord) ✅ · ledger holds/settle_full ✅ · shop/digital goods ✅ · webhooks v1 ✅ · referral graph + opt-in rev-share ✅ · per-tenant flags ✅ · crypto deposits (Solana/SPL/native SOL) ✅ · per-tenant TG bot ✅ · custom scores/seasons ✅ · **operator-dependent on the Global (ipfps) contour:** fiat provider credentials (confirm at onboarding), SMTP, web push for external tenants.

---

## Known doc drift (code wins; tracked for the next guide revision)

1. **`IPFPS_INTEGRATION.md` §13.1 claims webhook signing uses the "canonical secret (smallest `key_id`)" during rotation.** The code (`services/notifier/webhook_dispatcher.go`, `UpdateSecrets`) builds `slug → secret` from the KV key map with last-write-wins over Go map iteration — with two active keys the signing secret is effectively whichever key the map iteration hit last. Practical advice (unchanged): keep **both** rotation secrets valid on your verifier until the old key is revoked; consider flagging this to ops.
2. **Player-facing `GET /api/leaderboard` has no `score_type`/`entity_type` params** (handler accepts only `season`, `limit`, `offset` — `apps/platform/rest/user_handlers.go:313`). `IPFPS_INTEGRATION.md` §9.4's "read it back via `GET /api/leaderboard?season=<str>`" holds for custom **seasons**; custom **score_types/entity_types** are readable server-side only (S2S `GET /api/tenant/leaderboard`).
3. **S2S `GET /api/tenant/score/{user_id}` defaults `season` to the current calendar month** (`YYYY_MM` UTC), while the S2S **leaderboard** defaults to `all_time` — defaults differ per endpoint; always pass `season` explicitly when it matters.
4. S2S 429 bodies return `{"code":"SLOW_DOWN","error":"<localized string>","retry_after":N}`; the IAM `tenant_create` 429 returns plain `{"error":"SLOW_DOWN"}` with only the `Retry-After` header.
5. Self-serve tenants have `hosts:[]` in the registry even though `{slug}.demo.ipfps.org` resolves (demo rule, not the host list). Custom domains remain operator-side.

---

*Questions, tenant onboarding, token policies, feature requests: **support@ipfps.org**. Key compromise: email `KEY COMPROMISE — <slug>` from your registered contact address — we revoke and re-issue immediately (revocation is live; the old key fails closed with `403 unknown_key` at once).*
