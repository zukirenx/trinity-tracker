// Client-side JS: Core helpers: language, i18n runtime, api, formatting, tables.
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_CORE: string = `  function detectLang() {
    try {
      const saved = localStorage.getItem('lang');
      if (saved && TRANSLATIONS[saved]) return saved;
    } catch (e) { /* ignore */ }
    const nav = (navigator.language || 'en').toLowerCase().slice(0, 2);
    return TRANSLATIONS[nav] ? nav : 'en';
  }
  let LANG = detectLang();

  // ---- Timezone display preference (browser-local) ----
  var DISPLAY_TZ = (function () {
    try { return localStorage.getItem('display_tz') || 'Europe/Paris'; } catch (e) { return 'Europe/Paris'; }
  })();
  function setDisplayTZ(tz) {
    DISPLAY_TZ = tz;
    try { localStorage.setItem('display_tz', tz); } catch (e) { /* ignore */ }
  }
  /** Format a UTC ISO timestamp in the user's chosen display timezone. */
  function fmtTimestamp(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      var str = d.toLocaleString('en-GB', {
        timeZone: DISPLAY_TZ,
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      // Append short timezone label (last segment of IANA name, underscores → spaces)
      var tzShort = DISPLAY_TZ.indexOf('/') >= 0
        ? DISPLAY_TZ.split('/').pop().replace(/_/g, ' ')
        : DISPLAY_TZ;
      return str + ' \u200b(' + tzShort + ')';
    } catch (e) { return iso; }
  }
  function t(key, params) {
    const table = TRANSLATIONS[LANG] || TRANSLATIONS.en;
    let s = table[key];
    if (s === undefined) s = TRANSLATIONS.en[key];
    if (s === undefined) s = key;
    if (params) {
      Object.keys(params).forEach(function (k) {
        s = s.split('{' + k + '}').join(String(params[k]));
      });
    }
    return s;
  }
  function applyI18n(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      const key = el.getAttribute('data-i18n-html');
      if (key) el.innerHTML = t(key);
    });
    scope.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      const spec = el.getAttribute('data-i18n-attr');
      if (!spec) return;
      spec.split(',').forEach(function (pair) {
        const parts = pair.split(':');
        if (parts.length === 2) el.setAttribute(parts[0].trim(), t(parts[1].trim()));
      });
    });
    document.documentElement.lang = LANG;
  }
  function setLang(lang) {
    if (!TRANSLATIONS[lang]) return;
    LANG = lang;
    try { localStorage.setItem('lang', lang); } catch (e) { /* ignore */ }
    applyI18n();
  }

  function api(path) {
    const sep = path.includes('?') ? '&' : '?';
    return fetch(path + sep + 'token=' + encodeURIComponent(TOKEN), {
      headers: { 'Accept': 'application/json' },
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiPost(path, body) {
    const sep = path.includes('?') ? '&' : '?';
    return fetch(path + sep + 'token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data && data.error ? data.error : ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return iso; // already YYYY-MM-DD
  }
  function daysPill(days) {
    if (days === null || days === undefined) return '<span class="pill bad">never</span>';
    let cls = 'good';
    if (days > 14) cls = 'warn';
    if (days > 30) cls = 'bad';
    return '<span class="pill ' + cls + '">' + days + 'd</span>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // Generic sortable table renderer.
  function makeTable(opts) {
    const tbody = opts.table.querySelector('tbody');
    const ths = opts.table.querySelectorAll('th[data-sort]');
    let data = [];
    let sortKey = opts.defaultSort;
    let sortDir = opts.defaultDir || 'asc';

    function render() {
      const sorted = data.slice().sort(function (a, b) {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        return sortDir === 'asc' ? 1 : -1;
      });
      tbody.innerHTML = sorted.map(opts.row).join('');
      ths.forEach(function (th) {
        th.querySelectorAll('.arrow').forEach(function (a) { a.remove(); });
        if (th.dataset.sort === sortKey) {
          const span = document.createElement('span');
          span.className = 'arrow';
          span.textContent = sortDir === 'asc' ? '▲' : '▼';
          th.appendChild(span);
        }
      });
      opts.empty.classList.toggle('hidden', sorted.length > 0);
    }

    ths.forEach(function (th) {
      th.addEventListener('click', function () {
        const key = th.dataset.sort;
        if (sortKey === key) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortKey = key;
          sortDir = opts.defaultDirFor ? opts.defaultDirFor(key) : 'asc';
        }
        render();
      });
    });

    return {
      setData: function (rows) { data = rows; render(); },
    };
  }`;
