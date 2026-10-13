# IPFPS World's Fair Pavilion — Showcase Copy

A snapshot of the live **World's Fair** experience running on the IPFPS platform:
a Three.js landing page plus a fully functional **Developer Console** where a
visitor connects a Solana wallet, creates a tenant, mints S2S keys, edits
tenant config and reads live balances — no backend of your own required.

**Live:** https://ipfps.org/worldsfair

## Files

| File | What it is |
|---|---|
| `index.html` | Landing page + console markup, design system and the Three.js WebGL backdrop. Strict CSP, vanilla JS, no build step. |
| `app.js` | The console application (~1250 lines): wallet discovery (Wallet Standard + legacy adapters), session handling (30-day JWT in `sessionStorage`, sent as the `Init-Data` header), tenant CRUD, S2S key mint/reveal, config editor, transactions view, toasts. |
| `IPFPS_AGENT_SPEC.md` | The complete agent integration reference this console demonstrates (also the only doc an AI agent needs to integrate a product with IPFPS). |

## Run locally

```bash
cd showcase/worldsfair-pavilion
python3 -m http.server 8080
# open http://localhost:8080
```

## Honest caveat

The console calls the platform **same-origin** (`/api/*`). Served from
`localhost` those calls have nothing behind them — the full flow only works
where the IPFPS edge serves the site (https://ipfps.org/worldsfair) or on a
tenant origin of your own. The 3D landing visuals and the spec viewer work
anywhere.
