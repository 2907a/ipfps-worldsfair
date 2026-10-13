#!/usr/bin/env python3
"""MarbleBot local server: static files + IPFPS S2S proxy.

Serves the game on http://localhost:8000 and proxies the IPFPS tenant API
(Solana login, $MARBLE credits, leaderboard, shop) so the S2S secret never
reaches the browser. Credentials are read from the environment
(TENANT_HOST, TENANT_KEY_ID, TENANT_SECRET — see .env.example).
"""
import hashlib
import hmac
import json
import os
import re
import secrets as pysecrets
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PORT = int(os.environ.get("PORT", "8000"))

SETUP_HINT = (
    "Missing tenant credentials. Copy .env.example to .env and export vars: "
    "export $(grep -v '^#' .env | xargs)"
)


def load_config():
    host = os.environ.get("TENANT_HOST", "").strip()
    key_id = os.environ.get("TENANT_KEY_ID", "").strip()
    secret = os.environ.get("TENANT_SECRET", "").strip()
    if not (secret and key_id and host):
        raise SystemExit(SETUP_HINT)
    if not re.fullmatch(r"[0-9a-f]{64}", secret):
        raise SystemExit("TENANT_SECRET must be 64 lowercase hex chars (the HMAC secret from the console)")
    return secret, key_id, host


SECRET_HEX, KEY_ID, HOST = load_config()
BASE = f"https://{HOST}"


def http_json(method, path, payload=None, headers=None):
    body = b"" if payload is None else json.dumps(payload).encode()
    hdrs = {"Content-Type": "application/json"}
    hdrs.update(headers or {})
    req = urllib.request.Request(
        BASE + path,
        data=body if method != "GET" else None,
        method=method,
        headers=hdrs,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {"error": f"http_{e.code}"}


def s2s(method, path, payload=None):
    """Signed tenant S2S call (HMAC-SHA256 over the exact raw body bytes)."""
    body = b"" if payload is None else json.dumps(payload).encode()
    # the platform keys the HMAC with the secret's raw ASCII form (openssl -hmac style)
    sig = hmac.new(SECRET_HEX.encode(), body, hashlib.sha256).hexdigest()
    return http_json(
        method,
        path,
        payload,
        {"X-Tenant-Key-Id": KEY_ID, "X-Tenant-Signature": sig},
    )


def proxy(method, path, payload=None, extra_headers=None):
    """Plain same-shape proxy to the tenant origin (browser-facing calls)."""
    headers = {"Origin": f"https://{HOST}"}
    headers.update(extra_headers or {})
    return http_json(method, path, payload, headers)


def introspect(token):
    status, data = s2s("POST", "/api/tenant/introspect", {"token": token})
    if status == 200 and data.get("valid"):
        return data["user_id"]
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def _json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return {}

    def do_GET(self):
        if self.path == "/api/leaderboard":
            status, data = s2s(
                "GET",
                "/api/tenant/leaderboard?score_type=marble&entity_type=user&season=all_time&limit=50",
            )
            self._json(data, status)
        elif self.path == "/api/shop":
            # S2S catalog read — full product list incl. prices
            status, data = s2s("GET", "/api/tenant/products?limit=50")
            self._json(data, status)
        else:
            super().do_GET()

    def do_POST(self):
        body = self._body()
        path = self.path

        if path == "/api/auth/nonce":
            address = str(body.get("address", ""))
            if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", address):
                return self._json({"error": "invalid_address"}, 400)
            status, data = proxy("GET", f"/api/auth/nonce?address={address}")
            return self._json(data, status)

        if path == "/api/auth/verify":
            status, data = proxy("POST", "/api/auth/web3/verify", body)
            return self._json(data, status)

        if path == "/api/balance":
            uid = introspect(str(body.get("token", "")))
            if not uid:
                return self._json({"error": "invalid_token"}, 401)
            status, data = s2s("GET", f"/api/tenant/balance/{uid}")
            data["user_id"] = uid
            return self._json(data, status)

        if path == "/api/earn":
            uid = introspect(str(body.get("token", "")))
            if not uid:
                return self._json({"error": "invalid_token"}, 401)
            try:
                amount = int(body.get("amount", 0))
            except (TypeError, ValueError):
                amount = 0
            round_id = re.sub(r"[^A-Za-z0-9:._-]", "", str(body.get("round_id", "")))[:64]
            if not round_id:
                round_id = pysecrets.token_hex(8)
            if amount <= 0:
                return self._json({"error": "nothing_to_earn"}, 400)

            # 1 $MARBLE per marble collected, idempotent per round
            status, credit = s2s(
                "POST",
                "/api/tenant/balance/credit",
                {
                    "user_id": uid,
                    "currency": "MARBLE",
                    "amount": amount,
                    "tx_type": "game_win",
                    "comment": "MarbleBot round",
                    "idempotency_key": f"round:{round_id}:credit",
                },
            )
            if status != 200:
                return self._json(credit, status)

            # leaderboard slice: score_type "marble"
            status, score = s2s(
                "POST",
                "/api/tenant/score",
                {
                    "user_id": uid,
                    "points": amount,
                    "reason": "marbles_collected",
                    "score_type": "marble",
                    "idempotency_key": f"round:{round_id}:score",
                },
            )
            return self._json(
                {
                    "credited": amount,
                    "balance_after": credit.get("balance_after"),
                    "score": score if status == 200 else None,
                }
            )

        if path == "/api/inventory":
            token = str(body.get("token", ""))
            if not introspect(token):
                return self._json({"error": "invalid_token"}, 401)
            status, data = proxy("GET", "/api/shop/inventory?limit=50", None, {"Init-Data": token})
            return self._json(data, status)

        if path == "/api/shop/buy":
            token = str(body.get("token", ""))
            if not introspect(token):
                return self._json({"error": "invalid_token"}, 401)
            product_id = body.get("product_id")
            if not isinstance(product_id, int) or product_id <= 0:
                return self._json({"error": "invalid_product"}, 400)
            ikey = str(body.get("idempotency_key", ""))
            if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", ikey):
                return self._json({"error": "invalid_idempotency_key"}, 400)
            # two-phase: pending_payment -> active (debited) / rejected (insufficient funds)
            status, data = proxy(
                "POST",
                "/api/shop/buy",
                {"product_id": product_id, "idempotency_key": ikey},
                {"Init-Data": token},
            )
            return self._json(data, status)

        return self._json({"error": "not_found"}, 404)


def ensure_products():
    """Idempotently upsert the shop catalog SKU(s)."""
    skus = [
        {
            "code": "transformer_inferno",
            "title": "🔥 Inferno Transformer",
            "description": "Unlock the Inferno transformer skin — crimson armor with gold trim for your MarbleBot.",
            "price": 5,
            "currency": "MARBLE",
            "kind": "digital",
            "sort_order": 1,
            "content_type": "application/json",
            "content": {"skin": "inferno"},
        }
    ]
    for sku in skus:
        status, data = s2s("PUT", "/api/tenant/products", sku)
        print(f"shop SKU '{sku['code']}': HTTP {status} ({data.get('status', data.get('error', '?'))})")
        if status in (200, 201) and data.get("status") == "created":
            # fresh SKU may start inactive — make sure it's buyable
            st2, _ = s2s("POST", f"/api/tenant/products/{sku['code']}/activate")
            print(f"activate '{sku['code']}': HTTP {st2}")


if __name__ == "__main__":
    print(f"MarbleBot server on http://localhost:{PORT} (tenant: {HOST}, key: {KEY_ID})")
    try:
        ensure_products()
    except Exception as e:
        print(f"WARNING: product upsert failed: {e}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
