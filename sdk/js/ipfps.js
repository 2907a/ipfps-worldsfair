/**
 * IPFPS lightweight SDK — two helpers, zero dependencies.
 *
 * (a) createBrowserClient({ baseUrl, token }) — user-facing calls with the
 *     player JWT in the `Init-Data` header (NEVER `Authorization: Bearer`).
 *     Contracts: specs/AGENT_SPEC.md §4 (profile, transactions, leaderboard, shop).
 * (b) createSigner({ keyId, secretHex }) — Node-only HMAC signer for the
 *     Tenant S2S API (§5.1). NEVER ship the secret to a browser.
 */
(function (global) {
  'use strict';

  /**
   * Build a user-facing client. `token` may be a string or a () => string
   * (lazy, e.g. read from localStorage on each call). Pass `baseUrl` when the
   * app is NOT same-origin with the tenant API; same-origin is the caller's
   * responsibility (browsers set Origin automatically).
   * @param {{baseUrl?: string, token: string|Function}} opts
   */
  function createBrowserClient(opts) {
    var baseUrl = (opts && opts.baseUrl) || '';
    var getToken = typeof (opts && opts.token) === 'function' ? opts.token : function () { return opts && opts.token; };

    async function call(method, path, body) {
      var headers = { 'Init-Data': getToken() || '' };
      var init = { method: method, headers: headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      var res = await fetch(baseUrl + path, init);
      var data = null;
      try { data = await res.json(); } catch (e) { /* empty body */ }
      if (!res.ok) {
        var err = new Error((data && (data.error || data.code)) || ('HTTP ' + res.status));
        err.status = res.status;
        err.code = data && (data.code || data.error);
        err.retryAfter = res.headers.get('Retry-After');
        throw err;
      }
      return data;
    }

    return {
      /** GET /api/user/me — full profile; `balances` is the source of truth. */
      me: function () { return call('GET', '/api/user/me'); },
      /** GET /api/user/transactions?limit&offset — newest first, ISO created_at. */
      transactions: function (limit, offset) {
        return call('GET', '/api/user/transactions?limit=' + (limit || 20) + '&offset=' + (offset || 0));
      },
      /** GET /api/leaderboard?season&limit — xp/user slice only; my_rank_info on page 1. */
      leaderboard: function (season, limit) {
        return call('GET', '/api/leaderboard?limit=' + (limit || 50) + (season ? '&season=' + encodeURIComponent(season) : ''));
      },
      /** POST /api/shop/buy — two-phase: poll /api/shop/inventory until status flips. */
      buy: function (product_id, idempotencyKey) {
        return call('POST', '/api/shop/buy', { product_id: product_id, idempotency_key: idempotencyKey });
      },
    };
  }

  /**
   * Node-side HMAC signer for the Tenant S2S API (§5.1):
   *   X-Tenant-Key-Id / X-Tenant-Signature: hex(HMAC_SHA256(secret, rawBody)).
   * Sign the EXACT bytes you send; GETs sign the empty string.
   * @param {{keyId: string, secretHex: string}} creds
   */
  function createSigner(creds) {
    var crypto;
    try {
      crypto = require('crypto'); // eslint-disable-line global-require
    } catch (e) {
      crypto = null; // bundlers / browsers — sign() will fail loudly below
    }
    if (!creds || !creds.keyId || !/^[0-9a-f]{64}$/i.test(creds.secretHex || '')) {
      throw new Error('createSigner: keyId and 64-hex secretHex are required');
    }
    return {
      keyId: creds.keyId,
      /** @returns {{keyId: string, signature: string}} headers to send */
      sign: function (rawBody) {
        if (!crypto) throw new Error('signing requires Node.js crypto — never sign in the browser');
        var body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || '');
        return {
          keyId: creds.keyId,
          signature: crypto.createHmac('sha256', Buffer.from(creds.secretHex, 'hex')).update(body, 'utf8').digest('hex'),
        };
      },
    };
  }

  var api = { createBrowserClient: createBrowserClient, createSigner: createSigner };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.IPFPS = api;
})(typeof window !== 'undefined' ? window : globalThis);
