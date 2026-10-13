# IPFPS SDK — lightweight integration helpers

Two zero-dependency helpers for integrating a product with the IPFPS
multi-tenant gaming platform. The authoritative contracts live in
[`../specs/AGENT_SPEC.md`](../specs/AGENT_SPEC.md) (human/agent reference) and
[`../specs/openapi.yaml`](../specs/openapi.yaml) (machine-readable); this SDK
only wraps a frequently-used subset.

## What's inside

| File | Where it runs | Purpose |
|---|---|---|
| `python/ipfps_client.py` | Your **backend** (Python 3, stdlib only) | `IPFPSClient` — Tenant S2S API: `get_balance()`, `hold_balance()`, `settle_balance()`, `release_hold()`, `post_score()`, `get_leaderboard()`, `introspect()`, plus the public `get_escrow_config()`. HMAC-signs every request (`X-Tenant-Key-Id` / `X-Tenant-Signature`) and always sends the `Host` header for tenant resolution. Errors raise `IPFPSError(status, code, message)`. |
| `js/ipfps.js` | Browser **and** Node | `createBrowserClient({ baseUrl, token })` — player-facing calls (`me()`, `transactions()`, `leaderboard()`, `buy()`) with the JWT in the `Init-Data` header. `createSigner({ keyId, secretHex })` — Node-only HMAC signer for raw S2S requests (`fetch` + `sign(body)` yourself). |

## Install

None. Copy the files into your project:

```bash
cp sdk/python/ipfps_client.py your-backend/
cp sdk/js/ipfps.js your-frontend/
```

## Usage — Python (server-side, S2S)

```python
from ipfps_client import IPFPSClient
c = IPFPSClient("https://my-game.demo.ipfps.org", "my-game.demo.ipfps.org", KEY_ID, SECRET)
cfg = c.get_escrow_config()
bal = c.get_balance(user_id)
hold_id = c.hold_balance(user_id, 10, "COINS", idem_key, round_id=round_uuid)
c.settle_balance(hold_id)            # player lost — capture
# c.release_hold(hold_id)            # round cancelled — refund
c.post_score(user_id, 25, reason="level_complete")
```

## Usage — Node (S2S signing)

```js
const { createSigner } = require('./ipfps.js');
const signer = createSigner({ keyId: KEY_ID, secretHex: SECRET });
const body = JSON.stringify({ user_id, currency: 'COINS', amount: 1000, tx_type: 'credit', idempotency_key: 'qa-1' });
const { keyId, signature } = signer.sign(body);
await fetch(`${BASE}/api/tenant/balance/credit`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Tenant-Key-Id': keyId, 'X-Tenant-Signature': signature }, body });
```

## Usage — Browser (player-facing)

```js
const { createBrowserClient } = require('./ipfps.js'); // or window.IPFPS
const api = createBrowserClient({ token: () => localStorage.getItem('jwt') });
const me = await api.me();
const board = await api.leaderboard('all_time', 50);
const { item } = await api.buy(productId, crypto.randomUUID());
```

## Security invariants

- **The S2S secret is server-side only.** It is shown once at key mint; never
  put it in frontend code, bundles, env-vars shipped to clients or logs.
  `createSigner` refuses to run without Node `crypto` — do not polyfill it
  for the browser.
- **The browser never signs.** Money moves only through `/api/tenant/*` from
  your backend; the browser client only reads profiles and triggers
  player-facing flows with the JWT in `Init-Data`.
- Tenant resolution is **Host-based**: always call the API on your own tenant
  origin and keep the `Host` header intact (the Python client sets it for you).
