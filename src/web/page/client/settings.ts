// Client-side JS: Settings tab (timezone for everyone, event times for admins).
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_SETTINGS: string = `  // ---- Settings tab (admin only) ----
  var settingsInitialized = false;

  function settingsSetValue(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = String(val);
  }

  function settingsInit() {
    // ── Timezone selector (all users) ──────────────────────────────────────
    var tzSel = document.getElementById('settings-tz');
    if (tzSel) {
      tzSel.value = DISPLAY_TZ;
      tzSel.addEventListener('change', function () {
        setDisplayTZ(tzSel.value);
        evNeedsRefresh = true;
        // If an event is already loaded, re-render it immediately (panel may be hidden
        // but DOM will be updated; becomes visible when user switches back to Events).
        if (evCurrentEventId) { try { evLoadEvent(evCurrentEventId); } catch (e) { /* ignore */ } }
      });
    }
    if (!IS_ADMIN) return; // remaining controls are admin-only
    // ── Admin: Canyon / Desert settings ────────────────────────────────────
    settingsLoad();
    // Mark Canyon section unsaved whenever any field changes.
    function markCanyonUnsaved() {
      var st = document.getElementById('settings-canyon-status');
      if (st && st.textContent !== t('settings.unsaved')) {
        st.textContent = t('settings.unsaved');
        st.style.color = 'var(--warn)';
      }
    }
    var caoEl = document.getElementById('settings-canyon-auto-open');
    if (caoEl) caoEl.addEventListener('change', markCanyonUnsaved);
    var catEl = document.getElementById('settings-canyon-a-time');
    if (catEl) catEl.addEventListener('change', markCanyonUnsaved);
    var cbtEl = document.getElementById('settings-canyon-b-time');
    if (cbtEl) cbtEl.addEventListener('change', markCanyonUnsaved);
    var canyonSave = document.getElementById('settings-canyon-save');
    if (canyonSave) canyonSave.addEventListener('click', function () {
      var autoOpen = document.getElementById('settings-canyon-auto-open');
      settingsSave({
        canyonAutoOpen: autoOpen ? autoOpen.checked : true,
        canyonATime: (document.getElementById('settings-canyon-a-time') || {value: '16:00'}).value,
        canyonBTime: (document.getElementById('settings-canyon-b-time') || {value: '16:00'}).value,
      }, 'settings-canyon-status');
    });
    var canyonOpenNow = document.getElementById('settings-canyon-open-now');
    if (canyonOpenNow) canyonOpenNow.addEventListener('click', function () {
      var st = document.getElementById('settings-canyon-open-status');
      if (st) { st.textContent = t('settings.opening'); st.style.color = ''; }
      fetch('/api/events/open-canyon-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
        body: JSON.stringify({}),
      })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (res) {
          if (res.data && res.data.ok) {
            var week = (res.data.weekStart || (res.data.event && res.data.event.weekStart)) || '';
            if (st) {
              st.textContent = t(res.data.alreadyOpen ? 'settings.alreadyOpen' : 'settings.opened', { week: week });
              st.style.color = '';
            }
            evNeedsRefresh = true;
            setTimeout(function () { if (st) st.textContent = ''; }, 5000);
          } else {
            if (st) { st.textContent = t('common.error') + ((res.data && res.data.error) || ('HTTP ' + res.status)); st.style.color = 'var(--bad)'; }
          }
        })
        .catch(function (err) {
          if (st) { st.textContent = t('common.error') + err.message; st.style.color = 'var(--bad)'; }
        });
    });
    // Mark Desert section unsaved whenever any field changes.
    function markDesertUnsaved() {
      var st = document.getElementById('settings-desert-status');
      if (st && st.textContent !== t('settings.unsaved')) {
        st.textContent = t('settings.unsaved');
        st.style.color = 'var(--warn)';
      }
    }
    var datEl = document.getElementById('settings-desert-a-time');
    if (datEl) datEl.addEventListener('change', markDesertUnsaved);
    var dbtEl = document.getElementById('settings-desert-b-time');
    if (dbtEl) dbtEl.addEventListener('change', markDesertUnsaved);
    var desertSave = document.getElementById('settings-desert-save');
    if (desertSave) desertSave.addEventListener('click', function () {
      settingsSave({
        desertATime: (document.getElementById('settings-desert-a-time') || {value: '22:00'}).value,
        desertBTime: (document.getElementById('settings-desert-b-time') || {value: '13:00'}).value,
      }, 'settings-desert-status');
    });
  }

  function settingsLoad() {
    fetch('/api/settings?token=' + encodeURIComponent(TOKEN))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.settings) return;
        var s = data.settings;
        var caoEl = document.getElementById('settings-canyon-auto-open');
        if (caoEl) caoEl.checked = Boolean(s.canyonAutoOpen);
        settingsSetValue('settings-canyon-a-time', s.canyonATime);
        settingsSetValue('settings-canyon-b-time', s.canyonBTime);
        settingsSetValue('settings-desert-a-time', s.desertATime);
        settingsSetValue('settings-desert-b-time', s.desertBTime);
      })
      .catch(function (err) { console.error('Settings load error:', err); });
  }

  function settingsSave(fields, statusId) {
    var statusEl = document.getElementById(statusId);
    if (statusEl) statusEl.textContent = t('settings.saving');
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify(fields),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          if (statusEl) { statusEl.textContent = t('settings.saved'); statusEl.style.color = ''; }
          setTimeout(function () { if (statusEl) statusEl.textContent = ''; }, 3000);
          // Re-sync form from server response so UI always reflects stored state.
          if (data.settings) {
            var s = data.settings;
            var caoEl = document.getElementById('settings-canyon-auto-open');
            if (caoEl) caoEl.checked = Boolean(s.canyonAutoOpen);
            settingsSetValue('settings-canyon-a-time', s.canyonATime);
            settingsSetValue('settings-canyon-b-time', s.canyonBTime);
            settingsSetValue('settings-desert-a-time', s.desertATime);
            settingsSetValue('settings-desert-b-time', s.desertBTime);
          }
        } else {
          if (statusEl) statusEl.textContent = t('common.error') + (data.error || 'unknown error');
        }
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = t('common.error') + err.message;
      });
  }`;
