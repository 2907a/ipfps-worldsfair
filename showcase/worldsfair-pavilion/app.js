'use strict';
/* ================================================================
   IPFPS WORLD'S FAIR — console app
   Vanilla JS, no build step. Same-origin API via /api/*.
   Sessions: 30-day JWT in sessionStorage, sent as Init-Data header.
   All handlers bound via addEventListener (CSP: no inline scripts).
   ================================================================ */
(function () {

  /* ---------------- utils ---------------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function shortAddr(a) {
    if (!a) return '—';
    return a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a;
  }
  function toast(msg, kind) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 350);
    }, 4200);
  }
  function copyText(text, okMsg) {
    function done() { toast(okMsg || 'Copied to clipboard', 'ok'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast('Copy failed — select manually', 'err'); }
      ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }
  function setLoading(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.orig = btn.textContent;
      btn.textContent = label || 'Working…';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.orig || btn.textContent;
      btn.disabled = false;
    }
  }

  /* base58 encode (ed25519 signatures are 64 bytes) */
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58encode(bytes) {
    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    var num = BigInt(0);
    for (var i = 0; i < bytes.length; i++) num = (num << BigInt(8)) + BigInt(bytes[i]);
    var s = '';
    while (num > BigInt(0)) {
      var m = num % BigInt(58);
      s = B58[Number(m)] + s;
      num = num / BigInt(58);
    }
    var pad = '';
    for (var j = 0; j < zeros; j++) pad += '1';
    return pad + s;
  }

  function parseJwtExp(token) {
    try {
      var parts = token.split('.');
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.exp ? new Date(payload.exp * 1000) : null;
    } catch (e) { return null; }
  }

  /* ---------------- state ---------------- */
  var state = {
    token: null,
    address: null,
    walletName: null,
    me: null,
    tenants: [],
    selected: null,
    config: null,
    keys: []
  };

  var fileMode = location.protocol === 'file:';
  if (fileMode) {
    /* no server behind file:// — API calls will fail silently into toasts */
    console.info('[worldsfair] file:// mode — API features require hosting at ipfps.org');
  }

  /* ---------------- central fetch ---------------- */
  function apiFetch(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false && state.token) headers['Init-Data'] = state.token;
    var req = { method: method, headers: headers, credentials: 'same-origin' };
    if (opts.body !== undefined) req.body = JSON.stringify(opts.body);
    return fetch(path, req).then(function (res) {
      var retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
      if (res.status === 429) {
        return { ok: false, status: 429, code: 'SLOW_DOWN', retryAfter: retryAfter, data: null };
      }
      if (res.status === 401 && opts.auth !== false && state.token) {
        sessionClear();
        showView('landing');
        renderWalletBtn();
        toast('Session expired — please reconnect your wallet', 'warn');
        return { ok: false, status: 401, code: 'unauthorized', data: null };
      }
      if (res.status === 204) return { ok: true, status: 204, data: null };
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, code: (data && data.error) || null, data: data };
      }).catch(function () {
        return { ok: res.ok, status: res.status, code: null, data: null };
      });
    }).catch(function () {
      if (fileMode) {
        return { ok: false, status: 0, code: 'offline', data: null };
      }
      toast('Network error — check your connection', 'err');
      return { ok: false, status: 0, code: 'network', data: null };
    });
  }

  function apiErrorToast(r, fallback) {
    var msg = fallback || 'Request failed';
    if (r.status === 429) {
      var secs = r.retryAfter || 3;
      toast('SLOW_DOWN — retry in ' + secs + 's', 'warn');
      return;
    }
    if (r.code) msg += ' (' + r.code + ')';
    toast(msg, 'err');
  }

  /* ---------------- session ---------------- */
  function sessionSave(token, address, walletName, walletIcon) {
    state.token = token; state.address = address; state.walletName = walletName;
    state.walletIcon = walletIcon || null;
    try {
      sessionStorage.setItem('wf_token', token);
      sessionStorage.setItem('wf_address', address);
      sessionStorage.setItem('wf_wallet', walletName);
      if (walletIcon) sessionStorage.setItem('wf_wicon', walletIcon);
    } catch (e) { /* storage unavailable — keep in-memory */ }
  }
  function sessionLoad() {
    try {
      var t = sessionStorage.getItem('wf_token');
      var a = sessionStorage.getItem('wf_address');
      var w = sessionStorage.getItem('wf_wallet');
      if (t && a) {
        state.token = t; state.address = a; state.walletName = w || 'wallet';
        state.walletIcon = sessionStorage.getItem('wf_wicon') || null;
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  function sessionClear() {
    state.token = null; state.address = null; state.walletName = null;
    state.walletIcon = null;
    state.me = null; state.tenants = []; state.selected = null; state.config = null;
    try {
      sessionStorage.removeItem('wf_token');
      sessionStorage.removeItem('wf_address');
      sessionStorage.removeItem('wf_wallet');
      sessionStorage.removeItem('wf_wicon');
    } catch (e) { /* ignore */ }
  }
  function logout(silent) {
    var name = state.walletName;
    sessionClear();
    showView('landing');
    renderWalletBtn();
    if (!silent) toast('Disconnected' + (name ? ' — ' + name : ''), 'ok');
  }

  /* ---------------- wallet discovery ---------------- */
  var walletRegistry = new Map(); /* name -> adapter */
  var walletNamesLc = new Set(); /* lowercase-name dedup across standard + injected */

  function syncWalletHook() {
    /* test/dev hook: names of all discovered wallets */
    window.__wfWallets = Array.from(walletRegistry.keys());
  }
  syncWalletHook();

  function isSolanaStandard(w) {
    if (!w || !w.features) return false;
    if (!w.features['standard:connect'] || !w.features['standard:signMessage']) return false;
    if (w.chains && Array.isArray(w.chains) && w.chains.length) {
      return w.chains.some(function (c) { return typeof c === 'string' && c.indexOf('solana:') === 0; });
    }
    return true;
  }

  function registerStandardWallet(w) {
    if (!isSolanaStandard(w) || !w.name) return;
    var lc = String(w.name).toLowerCase();
    if (walletNamesLc.has(lc)) return;
    walletNamesLc.add(lc);
    walletRegistry.set(w.name, {
      name: w.name,
      icon: w.icon || null,
      kind: 'Wallet Standard',
      section: 'std',
      connect: function () {
        var feat = w.features['standard:connect'];
        return Promise.resolve(feat.connect({ silent: false })).then(function () {
          var acc = w.accounts && w.accounts[0];
          if (!acc || !acc.address) throw new Error('no account');
          return acc.address;
        });
      },
      signMessage: function (msgBytes) {
        var feat = w.features['standard:signMessage'];
        var acc = w.accounts && w.accounts[0];
        return Promise.resolve(feat.signMessage({ account: acc, message: msgBytes }))
          .then(function (out) {
            if (!out || !out.signature) throw new Error('no signature');
            return out.signature; /* Uint8Array */
          });
      }
    });
    syncWalletHook();
    if ($('#walletModal') && $('#walletModal').classList.contains('open')) renderWalletModalList();
  }

  function registerLegacyWallet(solanaObj, name) {
    if (!solanaObj) return;
    var lc = String(name).toLowerCase();
    if (walletNamesLc.has(lc)) return;
    walletNamesLc.add(lc);
    walletRegistry.set(name, {
      name: name,
      icon: (typeof solanaObj.icon === 'string' && solanaObj.icon) ? solanaObj.icon : null,
      kind: 'Injected',
      section: 'inj',
      connect: function () {
        return Promise.resolve(solanaObj.connect()).then(function () {
          if (!solanaObj.publicKey) throw new Error('no public key');
          return solanaObj.publicKey.toBase58 ? solanaObj.publicKey.toBase58() : String(solanaObj.publicKey);
        });
      },
      signMessage: function (msgBytes) {
        return Promise.resolve(solanaObj.signMessage(msgBytes, 'utf8')).then(function (out) {
          if (out && out.signature) return out.signature;
          throw new Error('no signature');
        });
      }
    });
    syncWalletHook();
    if ($('#walletModal') && $('#walletModal').classList.contains('open')) renderWalletModalList();
  }

  function scanLegacy() {
    try {
      if (window.solana) registerLegacyWallet(window.solana, window.solana.isPhantom ? 'Phantom' : 'Solana (window.solana)');
      if (window.phantom && window.phantom.solana && !window.solana) {
        registerLegacyWallet(window.phantom.solana, 'Phantom');
      }
      var legacy = ['backpack', 'solflare', 'slope', 'braveSolana', 'glow', 'glowSolana'];
      legacy.forEach(function (k) {
        if (window[k] && typeof window[k].connect === 'function') {
          registerLegacyWallet(window[k], k === 'glowSolana' ? 'Glow' : k.charAt(0).toUpperCase() + k.slice(1));
        }
      });
      /* some builds expose wallets under custom globals */
      if (window.nightly && typeof window.nightly.connect === 'function') {
        registerLegacyWallet(window.nightly, 'Nightly');
      }
    } catch (e) { /* extension sandbox quirks — ignore */ }
  }

  function discoverWallets() {
    /* Wallet Standard: register callback (canonical) + window event (fallback) */
    try {
      if (window.navigator && window.navigator.wallets && typeof window.navigator.wallets.register === 'function') {
        window.navigator.wallets.register(function (push) {
          push(function (wallets) {
            (wallets || []).forEach(registerStandardWallet);
            renderWalletModalList();
          });
        });
      }
    } catch (e) { /* ignore */ }
    if (!discoverWallets._stdEventBound) {
      window.addEventListener('wallet-standard', function (ev) {
        var list = ev && ev.detail ? (Array.isArray(ev.detail) ? ev.detail : [ev.detail]) : [];
        list.forEach(registerStandardWallet);
        renderWalletModalList();
      });
      discoverWallets._stdEventBound = true;
    }
    scanLegacy();
  }

  /* ---------------- modals ---------------- */
  function openModal(id) { $(id).classList.add('open'); }
  function closeModal(el) {
    var bd = el.closest ? el.closest('.modal-backdrop') : null;
    if (bd) bd.classList.remove('open');
  }
  function openWalletModal() {
    discoverWallets();
    renderWalletModalList();
    openModal('#walletModal');
  }

  function walletOptionButton(w) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wallet-option';
    var icon;
    if (w.icon) {
      icon = '<img src="' + escapeHtml(w.icon) + '" alt="" width="28" height="28">';
    } else {
      icon = '<span class="w-fallback" aria-hidden="true">' + escapeHtml(w.name.charAt(0).toUpperCase()) + '</span>';
    }
    btn.innerHTML = icon +
      '<span><span class="w-name">' + escapeHtml(w.name) + '</span><br>' +
      '<span class="w-kind">' + escapeHtml(w.kind) + '</span></span>';
    btn.addEventListener('click', function () {
      closeModal(btn);
      startLogin(w);
    });
    return btn;
  }

  function renderWalletModalList() {
    var box = $('#walletList');
    if (!box) return;
    var std = [], inj = [];
    walletRegistry.forEach(function (w) {
      if (w.section === 'std') std.push(w); else inj.push(w);
    });
    if (!std.length && !inj.length) {
      box.innerHTML = '<div class="no-wallets">No Solana wallet found — install ' +
        '<a href="https://phantom.com" target="_blank" rel="noopener">Phantom</a>, ' +
        '<a href="https://backpack.app" target="_blank" rel="noopener">Backpack</a> or ' +
        '<a href="https://solflare.com" target="_blank" rel="noopener">Solflare</a>, then reload.</div>';
      return;
    }
    box.innerHTML = '';
    if (std.length) {
      var l1 = document.createElement('div');
      l1.className = 'w-sec-label';
      l1.textContent = 'Wallet Standard';
      box.appendChild(l1);
      std.forEach(function (w) { box.appendChild(walletOptionButton(w)); });
    }
    if (inj.length) {
      var l2 = document.createElement('div');
      l2.className = 'w-sec-label';
      l2.textContent = 'Detected in browser';
      box.appendChild(l2);
      inj.forEach(function (w) { box.appendChild(walletOptionButton(w)); });
    }
  }

  /* ---------------- auth flow ---------------- */
  function startLogin(adapter) {
    if (fileMode) {
      toast('Console requires hosting on ipfps.org (API unavailable over file://)', 'warn');
      return;
    }
    var btn = $('#walletBtn');
    setLoading(btn, true, 'Connecting…');
    var address = null;
    adapter.connect()
      .then(function (addr) {
        address = addr;
        return apiFetch('/api/auth/nonce?address=' + encodeURIComponent(address), { auth: false });
      })
      .then(function (r) {
        if (!r.ok || !r.data || !r.data.nonce) {
          apiErrorToast(r, 'Could not get a sign-in nonce');
          throw new Error('nonce');
        }
        var message = 'Welcome to IPFPS World\'s Fair.\n' +
          'To authenticate, please sign this message to verify your wallet ownership.\n' +
          'Nonce: ' + r.data.nonce;
        return adapter.signMessage(new TextEncoder().encode(message)).then(function (sigBytes) {
          return { message: message, signature: b58encode(sigBytes) };
        });
      })
      .then(function (signed) {
        return apiFetch('/api/auth/web3/verify', {
          method: 'POST', auth: false,
          body: {
            address: address,
            chain: 'solana:mainnet',
            walletName: adapter.name,
            message: signed.message,
            signature: signed.signature,
            device_id: 'web-1',
            language: 'en'
          }
        });
      })
      .then(function (r) {
        if (!r.ok || !r.data || !r.data.token) {
          var msg = 'Wallet verification failed';
          if (r.status === 401) msg = 'Invalid signature — please try again';
          apiErrorToast(r, msg);
          throw new Error('verify');
        }
        sessionSave(r.data.token, address, adapter.name, adapter.icon);
        renderWalletBtn();
        toast(r.data.is_new_user ? 'Welcome to the network — account created' : 'Welcome back', 'ok');
        return loadConsole();
      })
      .catch(function (err) {
        if (err && err.message === 'nonce' || err && err.message === 'verify') return;
        if (err && (err.code === 4001 || /reject|denied|cancel/i.test(String(err && err.message || err)))) {
          toast('Connection rejected in wallet', 'warn');
        } else {
          toast('Wallet connection failed', 'err');
        }
      })
      .finally(function () { setLoading(btn, false); });
  }

  function renderWalletBtn() {
    var btn = $('#walletBtn');
    if (state.token && state.address) {
      btn.innerHTML = (state.walletIcon
        ? '<img src="' + escapeHtml(state.walletIcon) + '" alt="">'
        : '') + escapeHtml(shortAddr(state.address));
      btn.classList.add('connected');
      btn.title = 'Click to disconnect';
    } else {
      btn.textContent = 'Connect wallet';
      btn.classList.remove('connected');
      btn.title = '';
    }
  }

  /* ---------------- views ---------------- */
  function showView(name) {
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    $('#view-' + name).classList.add('active');
    document.body.classList.toggle('view-console', name === 'console');
    var vsL = $('#vsLanding'), vsC = $('#vsConsole');
    if (vsL && vsC) {
      vsL.classList.toggle('active', name === 'landing');
      vsC.classList.toggle('active', name === 'console');
    }
    if (name === 'landing') window.scrollTo(0, 0);
  }

  function openConsole() {
    if (!state.token) { openWalletModal(); return; }
    loadConsole();
  }

  /* ---------------- console loading ---------------- */
  function loadConsole() {
    showView('console');
    setLoading($('#walletBtn'), true, '…');
    return Promise.all([
      apiFetch('/api/user/me'),
      apiFetch('/api/tenants/mine')
    ]).then(function (results) {
      setLoading($('#walletBtn'), false);
      var meR = results[0], tR = results[1];
      if (meR.ok && meR.data) state.me = meR.data;
      if (tR.ok && tR.data && Array.isArray(tR.data.tenants)) state.tenants = tR.data.tenants;
      else if (!tR.ok && tR.status !== 401) apiErrorToast(tR, 'Could not load your apps');

      renderStats();
      renderTenantList();
      renderTenantDetail();

      var slug = state.selected || (state.tenants[0] && state.tenants[0].slug);
      if (slug) selectTenant(slug);
      else renderEmptyOverview();

      /* Activity tab — probe endpoint, hide it entirely when unavailable */
      return apiFetch('/api/user/transactions?limit=10').then(function (a) {
        var tab = $('#tabActivity');
        if (a.ok && a.data && Array.isArray(a.data.transactions)) {
          tab.hidden = false;
          renderActivity(a.data.transactions);
        } else {
          tab.hidden = true;
        }
      });
    });
  }

  function renderEmptyOverview() {
    $('#tenantDetail').innerHTML =
      '<div class="empty-state">No apps yet — create your first app to get an S2S key.</div>';
  }

  /* ---------------- stats (real data only) ---------------- */
  function renderStats() {
    var grid = $('#statGrid');
    var balances = (state.me && state.me.balances) || {};
    var wp = balances.WP;
    var wpHtml = (wp !== undefined && wp !== null)
      ? (wp % 1 === 0 ? String(wp) : wp.toFixed(2)) + ' WP'
      : '<span style="color:var(--muted)">—</span>';
    var exp = state.token ? parseJwtExp(state.token) : null;
    var expTxt = exp ? exp.toISOString().slice(0, 10) : '—';
    grid.innerHTML =
      '<div class="stat"><div class="s-label">Connected wallet</div><div class="s-value">' +
        escapeHtml(shortAddr(state.address)) + '</div></div>' +
      '<div class="stat"><div class="s-label">Session (JWT until)</div><div class="s-value good">' +
        escapeHtml(expTxt) + '</div></div>' +
      '<div class="stat"><div class="s-label">Apps</div><div class="s-value">' +
        state.tenants.length + '/3</div></div>' +
      '<div class="stat"><div class="s-label">WP Balance</div><div class="s-value">' + wpHtml + '</div></div>';
    $('#quotaUsed').textContent = String(state.tenants.length);
    var addBtn = $('#addTenantBtn');
    addBtn.disabled = state.tenants.length >= 3;
    addBtn.textContent = state.tenants.length >= 3 ? 'App limit reached (3/3)' : '+ Add app';
  }

  /* ---------------- tenant list ---------------- */
  function renderTenantList() {
    var box = $('#tenantList');
    box.innerHTML = '';
    if (!state.tenants.length) {
      box.innerHTML = '<div class="empty-state">No apps yet</div>';
      return;
    }
    state.tenants.forEach(function (t) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tenant-item' + (t.slug === state.selected ? ' active' : '');
      btn.innerHTML = '<span class="t-name">' + escapeHtml(t.name || t.slug) + '</span>' +
        '<span class="t-slug">' + escapeHtml(t.slug) + '</span>';
      btn.addEventListener('click', function () { selectTenant(t.slug); });
      box.appendChild(btn);
    });
  }

  function tenantHost(t) {
    if (t.hosts && t.hosts.length && t.hosts[0]) return t.hosts[0];
    return t.slug + '.demo.ipfps.org';
  }

  function selectTenant(slug) {
    state.selected = slug;
    state.config = null;
    state.keys = [];
    renderTenantList();
    var t = state.tenants.find(function (x) { return x.slug === slug; });
    $('#cfgSlug').textContent = t ? '· ' + t.slug : '';

    /* tenant detail */
    var det = $('#tenantDetail');
    if (!t) { renderEmptyOverview(); return; }
    det.innerHTML =
      '<div class="block"><h3>' + escapeHtml(t.name || t.slug) + '</h3>' +
      '<div class="kv-row"><span class="kv-key">slug</span><span class="kv-val">' +
        escapeHtml(t.slug) + '</span></div>' +
      '<div class="kv-row"><span class="kv-key">type</span><span class="kv-val">' +
        escapeHtml(t.type || 'external') + '</span></div>' +
      '<div class="kv-row"><span class="kv-key">host</span><span class="kv-val">' +
        escapeHtml(tenantHost(t)) + '</span>' +
        '<button class="copy-btn" data-copy="' + escapeHtml(tenantHost(t)) + '" type="button">copy</button></div>' +
      '<div class="kv-row"><span class="kv-key">s2s keys</span>' +
        '<span class="kv-val" id="keyListSlot"><span style="color:var(--muted)">loading…</span></span></div>' +
      '</div>';

    /* agent pack prompt refresh */
    renderAgentPrompt();

    /* config + keys */
    return Promise.all([
      apiFetch('/api/tenants/' + encodeURIComponent(slug)),
      apiFetch('/api/tenants/' + encodeURIComponent(slug) + '/s2s-keys')
    ]).then(function (rs) {
      var cfgR = rs[0], keysR = rs[1];
      if (cfgR.ok && cfgR.data) {
        state.config = cfgR.data.config || {};
        fillConfigForm();
      } else if (cfgR.status !== 401) apiErrorToast(cfgR, 'Could not load config');
      if (keysR.ok && keysR.data && Array.isArray(keysR.data.keys)) {
        state.keys = keysR.data.keys;
        renderKeys(slug);
      } else if (keysR.status !== 401) {
        renderKeysError();
      }
    });
  }

  function renderKeys(slug) {
    var slot = $('#keyListSlot');
    if (!slot) return;
    if (!state.keys.length) {
      slot.innerHTML = '<span style="color:var(--muted)">none</span>';
      return;
    }
    slot.innerHTML = '';
    state.keys.forEach(function (k) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0';
      var id = document.createElement('span');
      id.className = 'kv-val';
      id.textContent = k.key_id;
      var copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'copy-btn'; copy.textContent = 'copy';
      copy.addEventListener('click', function () { copyText(k.key_id, 'Key ID copied'); });
      var reveal = document.createElement('button');
      reveal.type = 'button'; reveal.className = 'mini-btn'; reveal.textContent = 'Reveal secret';
      reveal.addEventListener('click', function () {
        setLoading(reveal, true, 'Fetching…');
        apiFetch('/api/tenants/' + encodeURIComponent(slug) + '/s2s-keys/' +
          encodeURIComponent(k.key_id) + '/secret')
          .then(function (r) {
            setLoading(reveal, false);
            if (r.ok && r.data && r.data.secret) {
              openSecretModal(slug, k.key_id, r.data.secret);
            } else {
              apiErrorToast(r, 'Could not reveal secret');
            }
          });
      });
      wrap.appendChild(id); wrap.appendChild(copy); wrap.appendChild(reveal);
      slot.appendChild(wrap);
    });
  }
  function renderKeysError() {
    var slot = $('#keyListSlot');
    if (slot) slot.innerHTML = '<span style="color:var(--muted)">unavailable</span>';
  }

  var currentSecret = null;
  function openSecretModal(slug, keyId, secret) {
    currentSecret = secret;
    $('#secretTitle').textContent = 'S2S secret — ' + slug;
    $('#secretSub').textContent = 'Shown once — copy it now. The view is logged to the audit trail.';
    $('#secretBox').textContent = secret;
    $('#secretKeyId').textContent = keyId;
    openModal('#secretModal');
  }

  /* ---------------- config form ---------------- */
  function cfgBool(v) { return v === undefined || v === null ? true : !!v; }

  function fillConfigForm() {
    var c = state.config || {};
    $('#tglRegistration').checked = cfgBool(c.registration_enabled);
    $('#tglSolana').checked = cfgBool(c.solana_enabled !== undefined ? c.solana_enabled : c.web3_enabled);
    $('#tglFeed').checked = cfgBool(c.live_feed_enabled);
    var w = c.welcome || {};
    $('#welcomeAmount').value = (w.amount !== undefined && w.amount !== null) ? String(w.amount) : '0';
    $('#welcomeCurrency').value = w.currency || '';
    $('#webhookUrl').value = c.webhook_url || '';
    $('#corsOrigins').value = (c.cors_origins || []).join('\n');
  }

  var CURRENCY_RE = /^[A-Z0-9_]{2,32}$/;
  var WEBHOOK_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/;

  function patchConfig(patch, btn, okMsg) {
    var slug = state.selected;
    if (!slug) { toast('Select an app first', 'warn'); return; }
    setLoading(btn, true, 'Saving…');
    return apiFetch('/api/tenants/' + encodeURIComponent(slug), {
      method: 'PATCH', body: { config: patch }
    }).then(function (r) {
      setLoading(btn, false);
      if (r.ok && r.data) {
        state.config = r.data.config || {};
        fillConfigForm();
        toast(okMsg, 'ok');
      } else if (r.code === 'invalid_welcome') {
        toast('Invalid welcome: amount > 0 requires a currency code', 'err');
      } else {
        apiErrorToast(r, 'Save failed');
      }
    });
  }

  function bindConfig() {
    $('#saveToggles').addEventListener('click', function () {
      patchConfig({
        registration_enabled: $('#tglRegistration').checked,
        solana_enabled: $('#tglSolana').checked,
        live_feed_enabled: $('#tglFeed').checked
      }, this, 'Toggles saved');
    });

    $('#saveWelcome').addEventListener('click', function () {
      var amtRaw = $('#welcomeAmount').value.trim();
      var amt = parseInt(amtRaw, 10);
      var cur = $('#welcomeCurrency').value.trim().toUpperCase();
      var fAmt = $('#fWelcomeAmount'), fCur = $('#fWelcomeCurrency');
      fAmt.classList.remove('invalid'); fCur.classList.remove('invalid');
      if (amtRaw === '' || isNaN(amt) || amt < 0) {
        fAmt.classList.add('invalid'); return;
      }
      if (amt > 0 && !CURRENCY_RE.test(cur)) {
        fCur.classList.add('invalid'); return;
      }
      var welcome = { amount: amt };
      if (amt > 0) welcome.currency = cur;
      patchConfig({ welcome: welcome }, this, 'Welcome bonus saved');
    });

    $('#saveWebhook').addEventListener('click', function () {
      var url = $('#webhookUrl').value.trim();
      var f = $('#fWebhook');
      f.classList.remove('invalid');
      if (url && !WEBHOOK_RE.test(url)) {
        f.classList.add('invalid'); return;
      }
      patchConfig({ webhook_url: url }, this, 'Webhook saved');
    });

    $('#saveCors').addEventListener('click', function () {
      var origins = $('#corsOrigins').value.split('\n')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      patchConfig({ cors_origins: origins }, this, 'Origins saved');
    });
  }

  /* ---------------- agent pack ---------------- */
  var SPEC_URL = 'https://ipfps.org/worldsfair/IPFPS_AGENT_SPEC.md';
  var S2S_ENDPOINTS = [
    'POST /api/tenant/introspect',
    'POST /api/tenant/users',
    'GET  /api/tenant/users/lookup?username=',
    'GET  /api/tenant/users/{id}',
    'POST /api/tenant/balance/hold',
    'POST /api/tenant/balance/settle',
    'POST /api/tenant/balance/settle_full',
    'POST /api/tenant/balance/release',
    'POST /api/tenant/balance/credit',
    'GET  /api/tenant/balance/{user_id}',
    'POST /api/tenant/score',
    'GET  /api/tenant/score/{user_id}',
    'GET  /api/tenant/leaderboard',
    'POST /api/tenant/referrals/link',
    'GET  /api/tenant/referrals/{user_id}',
    'GET  /api/tenant/transactions/{user_id}',
    'GET  /api/tenant/payments',
    'PUT  /api/tenant/products',
    'GET  /api/tenant/products',
    'GET  /api/tenant/purchases'
  ];

  function renderAgentPrompt() {
    var slug = state.selected || '<app-slug>';
    var host = slug + '.demo.ipfps.org';
    var t = state.tenants.find(function (x) { return x.slug === slug; });
    if (t) host = tenantHost(t);
    var prompt =
      'You are the integration agent for the "' + slug + '" app on the IPFPS network.\n' +
      '\n' +
      'Gateway:   https://ipfps.org\n' +
      'Tenant:    ' + slug + '\n' +
      'Host:      ' + host + '\n' +
      '\n' +
      'Auth (S2S, per request):\n' +
      '  X-Tenant-Key-Id:       <key_id from the World\'s Fair console>\n' +
      '  X-Tenant-Signature:    hex(HMAC-SHA256(raw_request_body, <s2s_secret>))\n' +
      '\n' +
      'Key endpoints:\n' +
      S2S_ENDPOINTS.map(function (e) { return '  ' + e; }).join('\n') + '\n' +
      '\n' +
      'Rules:\n' +
      '  - Slug is pinned server-side from the key — never send it.\n' +
      '  - Money moves via balance hold/settle/release; check balances before holds.\n' +
      '  - Retries must be idempotent: reuse the same idempotency reference per operation.\n' +
      '  - Webhooks (user.registered, deposit.confirmed, referral.linked) arrive HMAC-signed at the tenant webhook_url.';
    $('#promptBox').textContent = prompt;
  }

  /* ---------------- microservice matrix (live set only) ---------------- */
  var SERVICES = [
    ['S2S API', '17 endpoints: users, balances, score, referrals, products, purchases.', 'live'],
    ['Solana escrow', 'Per-app SOL + USDC deposit addresses with token policies.', 'live'],
    ['Webhooks v1', 'HMAC-signed user.registered / deposit.confirmed / referral.linked.', 'live'],
    ['Shop digital goods', 'Shared product catalogue and purchase ledger.', 'live'],
    ['TG bots per-tenant', 'BYO bot token for app-scoped auth and notifications.', 'live'],
    ['Referral graph', 'Core-owned referral edges with source attribution.', 'live'],
    ['Live feed per-tenant', 'Opt-out live feed ring over Edge WS.', 'live'],
    ['Edge WS', 'Realtime balances, chat, live feed at the edge.', 'live'],
    ['EVM · Base · Arbitrum · TON · Tempo', 'Additional chains for deposits and escrow.', 'roadmap'],
    ['Ticketing', 'QR ticketing — self-serve onboarding.', 'roadmap']
  ];
  function renderServices() {
    var grid = $('#servicesGrid');
    grid.innerHTML = '';
    SERVICES.forEach(function (s) {
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = '<h3>' + escapeHtml(s[0]) +
        (s[2] === 'roadmap' ? ' <span class="tag roadmap">Roadmap</span>' : ' <span class="tag">Live</span>') +
        '</h3><p>' + escapeHtml(s[1]) + '</p>';
      grid.appendChild(card);
    });
  }

  /* ---------------- activity (real transactions only) ---------------- */
  function renderActivity(txs) {
    var body = $('#activityBody');
    if (!txs.length) {
      body.innerHTML = '<div class="empty-state">No activity yet.</div>';
      return;
    }
    var rows = txs.map(function (t) {
      var amt = Number(t.amount) || 0;
      var cls = amt >= 0 ? 'pos' : 'neg';
      var sign = amt >= 0 ? '+' : '−';
      var amtTxt = (amt % 1 === 0 ? Math.abs(amt) : Math.abs(amt).toFixed(2));
      var when = t.created_at ? String(t.created_at).slice(0, 19).replace('T', ' ') : '—';
      return '<tr>' +
        '<td>' + escapeHtml(t.type || '—') + '</td>' +
        '<td class="act-amt ' + cls + '">' + sign + escapeHtml(amtTxt) + '</td>' +
        '<td>' + escapeHtml(t.currency || '') + '</td>' +
        '<td class="hide-sm">' + escapeHtml(t.comment || '') + '</td>' +
        '<td class="hide-sm">' + escapeHtml(when) + '</td>' +
        '</tr>';
    }).join('');
    body.innerHTML = '<table class="act-table"><thead><tr>' +
      '<th>Type</th><th>Amount</th><th>Currency</th>' +
      '<th class="hide-sm">Comment</th><th class="hide-sm">Date</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ---------------- create app ---------------- */
  var SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$/;

  function bindCreateTenant() {
    var input = $('#ctSlug');
    input.addEventListener('input', function () {
      $('#fCtSlug').classList.remove('invalid');
      var v = input.value.trim();
      $('#ctPreview').textContent = (v && SLUG_RE.test(v) ? v : '<slug>') + '.demo.ipfps.org';
    });
    $('#ctSubmit').addEventListener('click', function () {
      var name = $('#ctName').value.trim();
      var slug = $('#ctSlug').value.trim();
      if (!name) { toast('Name is required', 'warn'); return; }
      if (!SLUG_RE.test(slug)) {
        $('#fCtSlug').classList.add('invalid');
        return;
      }
      setLoading(this, true, 'Creating…');
      var self = this;
      apiFetch('/api/tenants', { method: 'POST', body: { slug: slug, name: name } })
        .then(function (r) {
          setLoading(self, false);
          if (!r.ok) {
            if (r.status === 409 && r.code === 'slug_taken') {
              toast('slug_taken — this slug is already taken, pick another one', 'err');
            } else if (r.status === 429) {
              toast('SLOW_DOWN — retry in ' + (r.retryAfter || 3) + 's', 'warn');
            } else if (r.status === 403 && r.code === 'web3_required') {
              toast('web3_required — tenant creation requires a verified Solana wallet session', 'err');
            } else if (r.status === 403 && r.code === 'tenant_limit') {
              toast('tenant_limit — limit reached (3/3)', 'err');
            } else if (r.status === 400 && r.code === 'invalid_slug') {
              $('#fCtSlug').classList.add('invalid');
              toast('invalid_slug — 3–30 chars: lowercase letters, digits, dash', 'err');
            } else {
              apiErrorToast(r, 'Could not create app');
            }
            return;
          }
          closeModal($('#createModal'));
          $('#ctName').value = ''; $('#ctSlug').value = '';
          toast('App "' + slug + '" created', 'ok');
          /* refresh the list, select the new app */
          return apiFetch('/api/tenants/mine').then(function (t) {
            if (t.ok && t.data && Array.isArray(t.data.tenants)) {
              state.tenants = t.data.tenants;
              renderStats();
              selectTenant(slug);
              renderTenantList();
            }
          }).then(function () {
            /* secret shows exactly once, straight from the creation response */
            if (r.data && r.data.s2s_key && r.data.s2s_key.secret) {
              openSecretModal(slug, r.data.s2s_key.key_id || 'key-1', r.data.s2s_key.secret);
            }
          });
        });
    });
  }

  /* ---------------- tabs ---------------- */
  function bindTabs() {
    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        $$('.tab').forEach(function (t) { t.classList.remove('active'); });
        $$('.panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        $('#panel-' + tab.dataset.tab).classList.add('active');
      });
    });
  }

  /* ---------------- landing FX ---------------- */
  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fineHover = window.matchMedia &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* (a) typewriter rotation in the hero sub-line */
  function initTypewriter() {
    var el = $('#heroTw');
    if (!el || reduceMotion) return;
    var words = String(el.getAttribute('data-words') || '').split('|')
      .map(function (w) { return w.trim(); }).filter(Boolean);
    if (words.length < 2) return;
    var wi = 0, ci = words[0].length, deleting = false;
    function tick() {
      var word = words[wi];
      if (!deleting) {
        ci++;
        el.textContent = word.slice(0, ci);
        if (ci >= word.length) { deleting = true; setTimeout(tick, 1800); return; }
        setTimeout(tick, 64);
      } else {
        ci--;
        el.textContent = word.slice(0, ci);
        if (ci <= 0) { deleting = false; wi = (wi + 1) % words.length; setTimeout(tick, 380); return; }
        setTimeout(tick, 32);
      }
    }
    setTimeout(tick, 1800);
  }

  /* (b) pointer tilt on cards (rAF-throttled) */
  function initTilt() {
    if (reduceMotion || !fineHover) return;
    $$('#view-landing .card').forEach(function (card) {
      var raf = 0, rx = 0, ry = 0;
      function apply() {
        raf = 0;
        card.style.transform = 'perspective(720px) rotateX(' + rx.toFixed(2) +
          'deg) rotateY(' + ry.toFixed(2) + 'deg) translateY(-2px)';
      }
      card.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        var r = card.getBoundingClientRect();
        ry = ((e.clientX - r.left) / r.width - 0.5) * 7;
        rx = -((e.clientY - r.top) / r.height - 0.5) * 7;
        if (!raf) raf = requestAnimationFrame(apply);
      });
      card.addEventListener('pointerleave', function () {
        rx = 0; ry = 0;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        card.style.transform = '';
      });
    });
  }

  /* (d) reveal-on-scroll for landing sections */
  function initReveal() {
    var els = $$('#view-landing .section, #view-landing .closing');
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    els.forEach(function (el) { el.classList.add('reveal'); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach(function (el) { io.observe(el); });
  }

  /* (e) magnetic hover on primary buttons */
  function initMagnetic() {
    if (reduceMotion || !fineHover) return;
    ['#heroCta', '#heroExplore', '#walletBtn'].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      var raf = 0, tx = 0, ty = 0;
      function apply() {
        raf = 0;
        el.style.translate = tx.toFixed(1) + 'px ' + ty.toFixed(1) + 'px';
      }
      el.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        var r = el.getBoundingClientRect();
        tx = (e.clientX - (r.left + r.width / 2)) * 0.22;
        ty = (e.clientY - (r.top + r.height / 2)) * 0.32;
        if (!raf) raf = requestAnimationFrame(apply);
      });
      el.addEventListener('pointerleave', function () {
        tx = 0; ty = 0;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        el.style.translate = '0px 0px';
      });
    });
  }

  /* (c) click on the hero/section backdrop -> particle impulse + core pulse.
     Wired against window.__wfPulse, which initScene exposes. */
  function initBackdropPulse() {
    document.addEventListener('click', function (e) {
      if (document.body.classList.contains('view-console')) return;
      if (e.target.closest && e.target.closest(
        'a,button,input,textarea,select,label,.modal,.modal-backdrop,.site-header,.card')) return;
      if (typeof window.__wfPulse === 'function') window.__wfPulse(e.clientX, e.clientY);
    });
  }

  /* ---------------- Three.js backdrop ----------------
     Dome + core + rings + particles (r128, global THREE). */
  function initScene() {
    var canvas = $('#webgl-canvas');
    window.__wfPulse = function () {}; /* no-op until the scene is up */
    if (!window.THREE || !canvas) { window.__wfReady = true; return; }
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    } catch (e) { window.__wfReady = true; return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05060f, 0.028);
    var camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
    camera.position.set(0, 2.5, 22);

    /* dome */
    var domeGeo = new THREE.SphereGeometry(46, 28, 18);
    var dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({
      color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.05
    }));
    scene.add(dome);

    /* core */
    var core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(3.4, 1),
      new THREE.MeshBasicMaterial({ color: 0x14f195, wireframe: true, transparent: true, opacity: 0.55 })
    );
    var coreInner = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.2, 0),
      new THREE.MeshBasicMaterial({ color: 0x9945ff, wireframe: true, transparent: true, opacity: 0.65 })
    );
    scene.add(core); scene.add(coreInner);

    /* rings */
    var rings = [];
    [[6.4, 0x22d3ee, 0.32, 0.5], [8.6, 0x9945ff, 0.24, -0.34], [11.2, 0x14f195, 0.16, 0.2]].forEach(function (cfg) {
      var r = new THREE.Mesh(
        new THREE.TorusGeometry(cfg[0], 0.02, 8, 140),
        new THREE.MeshBasicMaterial({ color: cfg[1], transparent: true, opacity: cfg[2] })
      );
      r.rotation.x = Math.PI / 2 + cfg[3];
      scene.add(r);
      rings.push(r);
    });

    /* particles */
    var COUNT = 900;
    var pos = new Float32Array(COUNT * 3);
    for (var i = 0; i < COUNT; i++) {
      var rad = 12 + Math.random() * 30;
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = rad * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = rad * Math.cos(ph) * 0.6;
      pos[i * 3 + 2] = rad * Math.sin(ph) * Math.sin(th);
    }
    var pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
      color: 0x9be8ff, size: 0.09, transparent: true, opacity: 0.7, sizeAttenuation: true
    }));
    scene.add(particles);

    /* particle physics state: home positions + velocities (impulse on click) */
    var home = pos.slice();
    var vel = new Float32Array(COUNT * 3);
    var pulseT = 0;

    window.__wfPulse = function (clientX, clientY) {
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      var ndcX = (clientX / w) * 2 - 1, ndcY = -(clientY / h) * 2 + 1;
      var v = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
      var dir = v.sub(camera.position).normalize();
      var tt = -camera.position.z / (dir.z || -1e-6);
      if (!isFinite(tt) || tt < 0) tt = 20;
      var wx = camera.position.x + dir.x * tt;
      var wy = camera.position.y + dir.y * tt;
      pulseT = 1;
      for (var pi = 0; pi < COUNT; pi++) {
        var ix = pi * 3;
        var dx = pos[ix] - wx, dy = pos[ix + 1] - wy;
        var d2 = dx * dx + dy * dy + 4;
        var d = Math.sqrt(d2);
        var imp = Math.min(3.5, 90 / d2);
        vel[ix] += (dx / d) * imp;
        vel[ix + 1] += (dy / d) * imp;
        vel[ix + 2] += imp * 0.35;
      }
    };

    var mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
    window.addEventListener('pointermove', function (e) {
      targetX = (e.clientX / window.innerWidth - 0.5) * 2;
      targetY = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });

    function resize() {
      var w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    resize();

    window.__wfReady = true;

    var running = true, rafId = 0, t = 0;
    function frame() {
      if (!running) return;
      t += 0.004;
      mouseX += (targetX - mouseX) * 0.04;
      mouseY += (targetY - mouseY) * 0.04;
      core.rotation.y = t * 1.6; core.rotation.x = t * 0.7;
      coreInner.rotation.y = -t * 2.2;
      pulseT *= 0.95;
      core.scale.setScalar((1 + Math.sin(t * 3) * 0.04) * (1 + pulseT * 0.4));
      coreInner.scale.setScalar(1 + pulseT * 0.55);
      rings.forEach(function (r, i) { r.rotation.z = t * (0.24 + i * 0.1) * (i % 2 ? -1 : 1); });
      particles.rotation.y = t * 0.25;
      dome.rotation.y = t * 0.08;
      /* particle spring-back + impulse decay */
      for (var pi = 0; pi < COUNT; pi++) {
        var ix = pi * 3;
        vel[ix] = (vel[ix] + (home[ix] - pos[ix]) * 0.0022) * 0.94;
        vel[ix + 1] = (vel[ix + 1] + (home[ix + 1] - pos[ix + 1]) * 0.0022) * 0.94;
        vel[ix + 2] = (vel[ix + 2] + (home[ix + 2] - pos[ix + 2]) * 0.0022) * 0.94;
        pos[ix] += vel[ix];
        pos[ix + 1] += vel[ix + 1];
        pos[ix + 2] += vel[ix + 2];
      }
      pGeo.attributes.position.needsUpdate = true;
      camera.position.x = mouseX * 2.2;
      camera.position.y = 2.5 - mouseY * 1.6;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(frame);
    }
    frame();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
      } else if (!running) {
        running = true;
        frame();
      }
    });
  }

  /* ---------------- global wiring ---------------- */
  function bindGlobal() {
    $('#walletBtn').addEventListener('click', function () {
      if (state.token) { logout(); return; }
      openWalletModal();
    });
    $('#vsLanding').addEventListener('click', function () { showView('landing'); });
    $('#vsConsole').addEventListener('click', openConsole);
    $('#heroCta').addEventListener('click', openConsole);
    $('#heroExplore').addEventListener('click', function () {
      var el = $('#showcase');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    });
    $('#addTenantBtn').addEventListener('click', function () {
      if (state.tenants.length >= 3) {
        toast('App limit reached (3/3) — more slots come with monetization', 'warn');
        return;
      }
      openModal('#createModal');
      setTimeout(function () { $('#ctName').focus(); }, 120);
    });
    $('#copySpecUrl').addEventListener('click', function () {
      copyText(SPEC_URL, 'Spec URL copied');
    });
    $('#copyPrompt').addEventListener('click', function () {
      copyText($('#promptBox').textContent, 'Prompt copied');
    });
    $('#copySecret').addEventListener('click', function () {
      if (currentSecret) copyText(currentSecret, 'Secret copied');
    });
    /* copy buttons rendered inside tenant detail (delegation) */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-copy]') : null;
      if (btn) copyText(btn.getAttribute('data-copy'), 'Copied to clipboard');
      var closer = e.target.closest ? e.target.closest('[data-close]') : null;
      if (closer) closeModal(closer);
      if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
        e.target.classList.remove('open');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $$('.modal-backdrop.open').forEach(function (m) { m.classList.remove('open'); });
      }
    });
  }

  /* ---------------- boot ---------------- */
  function init() {
    discoverWallets();
    /* late registrants (extensions inject after load) */
    setTimeout(scanLegacy, 800);
    setTimeout(scanLegacy, 2500);
    renderWalletBtn();
    bindGlobal();
    bindTabs();
    bindCreateTenant();
    bindConfig();
    renderServices();
    renderAgentPrompt();
    initScene();
    initTypewriter();
    initTilt();
    initReveal();
    initMagnetic();
    initBackdropPulse();
    if (sessionLoad() && !fileMode) {
      loadConsole();
    } else {
      showView('landing');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
