"""Minimal IPFPS Tenant S2S client (Python 3, stdlib only).

Spec: specs/AGENT_SPEC.md (§5 Tenant S2S API). Every /api/tenant/* call is
HMAC-SHA256-signed with the per-tenant S2S secret; the gateway resolves the
tenant from the Host header, so `tenant_host` is mandatory on every request.
"""

import hashlib
import hmac
import json
import os
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

API_BASE = "/api/tenant"


@dataclass
class IPFPSError(Exception):
    """Raised for any non-2xx API response (401/403/404/409/429/5xx)."""

    status: int
    code: str
    message: str

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"IPFPSError({self.status} {self.code}: {self.message})"


class IPFPSClient:
    """Server-side client for the IPFPS Tenant S2S API.

    Args:
        gateway_url: Tenant origin, e.g. "https://my-game.demo.ipfps.org".
        tenant_host: Host header value used for tenant resolution (usually
            the same host as in gateway_url, without the scheme).
        key_id: S2S key id ("k_01J..."), from tenant creation or key mint.
        secret: 64-char hex S2S secret (shown once — keep server-side only).
    """

    def __init__(self, gateway_url: str, tenant_host: str, key_id: str, secret: str) -> None:
        if len(secret) != 64:
            raise ValueError("secret must be 64 hex chars")
        self.gateway_url = gateway_url.rstrip("/")
        self.tenant_host = tenant_host
        self.key_id = key_id
        self._secret = bytes.fromhex(secret)

    def _sign(self, raw_body: bytes) -> str:
        """hex(HMAC_SHA256(secret, raw_body)) — sign the exact bytes sent."""
        return hmac.new(self._secret, raw_body, hashlib.sha256).hexdigest()

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """HTTP request with Host/X-Tenant-Key-Id/X-Tenant-Signature headers."""
        raw = json.dumps(body).encode("utf-8") if body is not None else b""
        req = urllib.request.Request(
            f"{self.gateway_url}{path}",
            data=raw if method != "GET" else None,
            method=method,
            headers={
                "Host": self.tenant_host,
                "Content-Type": "application/json",
                "X-Tenant-Key-Id": self.key_id,
                "X-Tenant-Signature": self._sign(raw),  # GET signs the empty string
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = resp.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            message = e.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(message)
                code = parsed.get("code") or parsed.get("error") or "error"
                message = parsed.get("error") or message
            except ValueError:
                code = "http_error"
            raise IPFPSError(e.code, code, message) from None

    # -- balances / holds (AGENT_SPEC §5.3 #5-8, §6.2) ----------------------

    def get_balance(self, user_id: str) -> Dict[str, Any]:
        """GET /api/tenant/balance/{user_id} -> {"user_id", "balances": {CUR: amt}}."""
        return self._request("GET", f"{API_BASE}/balance/{user_id}")

    def hold_balance(self, user_id: str, amount: float, currency: str,
                     idempotency_key: str, round_id: Optional[str] = None) -> str:
        """POST /api/tenant/balance/hold — debit now, decide later.

        Returns the hold_id (keep it with your round state for settle/release).
        Funds are debited immediately; 409 insufficient_funds on short balance.
        """
        body: Dict[str, Any] = {"user_id": user_id, "currency": currency,
                                "amount": amount, "idempotency_key": idempotency_key}
        if round_id:
            body["round_id"] = round_id
        return self._request("POST", f"{API_BASE}/balance/hold", body)["hold_id"]

    def settle_balance(self, hold_id: str) -> Dict[str, Any]:
        """POST /api/tenant/balance/settle {hold_id} — capture the hold (player lost).

        Idempotent by hold_id; balance is untouched by settle itself.
        """
        return self._request("POST", f"{API_BASE}/balance/settle", {"hold_id": hold_id})

    def release_hold(self, hold_id: str) -> Dict[str, Any]:
        """POST /api/tenant/balance/release {hold_id} — cancel hold, return funds."""
        return self._request("POST", f"{API_BASE}/balance/release", {"hold_id": hold_id})

    # -- scores / leaderboard (AGENT_SPEC §5.3 #13, #15, §11) ---------------

    def post_score(self, user_id: str, score: float, score_type: str = "xp",
                   season: Optional[str] = None, entity_type: Optional[str] = None,
                   idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/tenant/score — apply a signed score delta (0 rejected).

        `score` maps to the spec's `points`; defaults write the xp/user slice
        (levels move when that is the tenant's leveling source).
        """
        body: Dict[str, Any] = {"user_id": user_id, "points": score, "score_type": score_type}
        if season:
            body["season"] = season
        if entity_type:
            body["entity_type"] = entity_type
        if idempotency_key:
            body["idempotency_key"] = idempotency_key
        return self._request("POST", f"{API_BASE}/score", body)

    def get_leaderboard(self, score_type: Optional[str] = None, season: Optional[str] = None,
                        limit: int = 50) -> Dict[str, Any]:
        """GET /api/tenant/leaderboard — read any (score_type, entity_type, season) slice.

        Empty season means all_time here (unlike the score endpoint).
        """
        qs = f"limit={limit}"
        if score_type:
            qs += f"&score_type={score_type}"
        if season:
            qs += f"&season={season}"
        return self._request("GET", f"{API_BASE}/leaderboard?{qs}")

    # -- misc (AGENT_SPEC §5.3 #1, §4.6) -----------------------------------

    def introspect(self, jwt: str) -> Dict[str, Any]:
        """POST /api/tenant/introspect {token} — validate a player JWT.

        Returns {"valid": false} (never 401) for bad/expired tokens.
        """
        return self._request("POST", f"{API_BASE}/introspect", {"token": jwt})

    def get_escrow_config(self) -> Dict[str, Any]:
        """GET /api/deposit/config — PUBLIC per-tenant crypto token policies.

        Origin-exempt and unsigned: sent with only the Host header so the
        gateway still resolves the correct tenant. tokens:[] until ops
        registers a policy for your tenant.
        """
        req = urllib.request.Request(
            f"{self.gateway_url}/api/deposit/config",
            headers={"Host": self.tenant_host},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())


if __name__ == "__main__":
    tenant_host = os.environ["TENANT_HOST"]            # e.g. my-game.demo.ipfps.org
    client = IPFPSClient(
        gateway_url=f"https://{tenant_host}",
        tenant_host=tenant_host,
        key_id=os.environ["KEY_ID"],
        secret=os.environ["SECRET"],
    )
    print("escrow:", client.get_escrow_config())
    user_id = os.environ.get("USER_ID")
    if user_id:
        print("balance:", client.get_balance(user_id))
        print("hold_id:", client.hold_balance(user_id, 10, "COINS", str(uuid.uuid7())))
