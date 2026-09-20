// Client-side JS: Settings tab (timezone for everyone, event times for admins).
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_SETTINGS: string = `  // ---- Settings tab (admin only) ----
  var settingsInitialized = false;

  function settingsSetValue(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = String(val);
  }

  // Compact points formatting for score-default inputs (7200000 -> "7.2M").
  function scoreFmt(n) {
    if (n === null || n === undefined || n === '') return '';
    if (!isFinite(Number(n))) return String(n);
    var v = Number(n);
    if (v >= 1000000) {
      var m = v / 1000000;
      return (m >= 100 ? String(Math.round(m)) : String(Math.round(m * 10) / 10)) + 'M';
    }
    if (v >= 1000) return (Math.round(v / 100) / 10) + 'k';
    return String(v);
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
    // ── Admin: Leaderboard score-penalty defaults ──────────────────────────
    function markScoreUnsaved() {
      var st = document.getElementById('settings-score-status');
      if (st && st.textContent !== t('settings.unsaved')) {
        st.textContent = t('settings.unsaved');
        st.style.color = 'var(--warn)';
      }
    }
    ['settings-score-min', 'settings-score-below', 'settings-score-max', 'settings-score-step', 'settings-score-cap', 'settings-score-streak'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', markScoreUnsaved);
    });
    var scoreSave = document.getElementById('settings-score-save');
    if (scoreSave) scoreSave.addEventListener('click', function () {
      var maxRaw = (document.getElementById('settings-score-max') || { value: '' }).value.trim();
      settingsSave({
        scoreMinPoints: (document.getElementById('settings-score-min') || { value: '' }).value,
        scoreBelowPenalty: Number((document.getElementById('settings-score-below') || { value: '1' }).value),
        scoreMaxPoints: maxRaw === '' ? null : maxRaw,
        scoreSevereStep: (document.getElementById('settings-score-step') || { value: '' }).value,
        scoreMaxCap: Number((document.getElementById('settings-score-cap') || { value: '5' }).value),
        scoreStreakThreshold: Number((document.getElementById('settings-score-streak') || { value: '2' }).value),
      }, 'settings-score-status');
    });
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
    var cctEl = document.getElementById('settings-canyon-close-time');
    if (cctEl) cctEl.addEventListener('change', markCanyonUnsaved);
    var canyonSave = document.getElementById('settings-canyon-save');
    if (canyonSave) canyonSave.addEventListener('click', function () {
      var autoOpen = document.getElementById('settings-canyon-auto-open');
      settingsSave({
        canyonAutoOpen: autoOpen ? autoOpen.checked : true,
        canyonATime: (document.getElementById('settings-canyon-a-time') || {value: '16:00'}).value,
        canyonBTime: (document.getElementById('settings-canyon-b-time') || {value: '16:00'}).value,
        canyonCloseTime: (document.getElementById('settings-canyon-close-time') || {value: '12:00'}).value,
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
            // Registration is now open for this week — no point keeping the button enabled.
            settingsSetOpenNowDisabled(true);
            if (st) st.setAttribute('data-open-state', 'already-open');
            evNeedsRefresh = true;
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
    var dctEl = document.getElementById('settings-desert-close-time');
    if (dctEl) dctEl.addEventListener('change', markDesertUnsaved);
    var desertSave = document.getElementById('settings-desert-save');
    if (desertSave) desertSave.addEventListener('click', function () {
      settingsSave({
        desertATime: (document.getElementById('settings-desert-a-time') || {value: '22:00'}).value,
        desertBTime: (document.getElementById('settings-desert-b-time') || {value: '13:00'}).value,
        desertCloseTime: (document.getElementById('settings-desert-close-time') || {value: '12:00'}).value,
      }, 'settings-desert-status');
    });
  }

  // Toggle the "open Canyon now" button. The button carries inline background/
  // color styles, which override the browser's native disabled graying — so a
  // merely-disabled button still looks clickable. Apply explicit visual styling
  // (faded + non-clickable cursor) alongside the attribute.
  function settingsSetOpenNowDisabled(disabled) {
    var btn = document.getElementById('settings-canyon-open-now');
    if (!btn) return;
    if (disabled) {
      btn.setAttribute('disabled', 'true');
      btn.style.opacity = '0.45';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.removeAttribute('disabled');
      btn.style.opacity = '';
      btn.style.cursor = '';
    }
  }

  // Disable the "open Canyon now" button when registration is already open for
  // the upcoming week (info comes from GET /api/settings as canyonOpenNow).
  function settingsUpdateOpenNowButton(info) {
    var st = document.getElementById('settings-canyon-open-status');
    if (info && info.alreadyOpen) {
      settingsSetOpenNowDisabled(true);
      if (st) {
        st.textContent = t('settings.alreadyOpen', { week: info.weekStart });
        st.style.color = '';
        st.setAttribute('data-open-state', 'already-open');
      }
    } else {
      settingsSetOpenNowDisabled(false);
      // Clear a stale already-open note (e.g. the week rolled over); never
      // touch transient messages such as errors (they carry no attribute).
      if (st && st.getAttribute('data-open-state') === 'already-open') {
        st.textContent = '';
        st.removeAttribute('data-open-state');
      }
    }
  }

  // Lightweight refresh of just the open-now button state (never touches the
  // form, so unsaved edits survive tab switches). Called on every visit to the
  // Settings tab — the event may have been opened elsewhere since last time.
  function settingsRefreshOpenState() {
    fetch('/api/settings?token=' + encodeURIComponent(TOKEN))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.canyonOpenNow) settingsUpdateOpenNowButton(data.canyonOpenNow);
      })
      .catch(function (err) { console.error('Settings open-state refresh error:', err); });
  }

  function settingsLoad() {
    fetch('/api/settings?token=' + encodeURIComponent(TOKEN))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.canyonOpenNow) settingsUpdateOpenNowButton(data.canyonOpenNow);
        if (!data.settings) return;
        var s = data.settings;
        var caoEl = document.getElementById('settings-canyon-auto-open');
        if (caoEl) caoEl.checked = Boolean(s.canyonAutoOpen);
        settingsSetValue('settings-canyon-a-time', s.canyonATime);
        settingsSetValue('settings-canyon-b-time', s.canyonBTime);
        settingsSetValue('settings-canyon-close-time', s.canyonCloseTime || '12:00');
        settingsSetValue('settings-desert-a-time', s.desertATime);
        settingsSetValue('settings-desert-b-time', s.desertBTime);
        settingsSetValue('settings-desert-close-time', s.desertCloseTime || '12:00');
        // Score-penalty defaults (points accept M/k suffixes on save; show compact here).
        var smin = document.getElementById('settings-score-min');
        if (smin) smin.value = scoreFmt(s.scoreMinPoints !== undefined ? s.scoreMinPoints : 7200000);
        var sbelow = document.getElementById('settings-score-below');
        if (sbelow) sbelow.value = String(s.scoreBelowPenalty !== undefined ? s.scoreBelowPenalty : 1);
        var smax = document.getElementById('settings-score-max');
        if (smax) smax.value = (s.scoreMaxPoints === null || s.scoreMaxPoints === undefined) ? '' : scoreFmt(s.scoreMaxPoints);
        var sstep = document.getElementById('settings-score-step');
        if (sstep) sstep.value = scoreFmt(s.scoreSevereStep !== undefined ? s.scoreSevereStep : 1000000);
        var scap = document.getElementById('settings-score-cap');
        if (scap) scap.value = String(s.scoreMaxCap !== undefined ? s.scoreMaxCap : 5);
        var sstreak = document.getElementById('settings-score-streak');
        if (sstreak) sstreak.value = String(s.scoreStreakThreshold !== undefined ? s.scoreStreakThreshold : 2);
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
            settingsSetValue('settings-canyon-close-time', s.canyonCloseTime || '12:00');
            settingsSetValue('settings-desert-a-time', s.desertATime);
            settingsSetValue('settings-desert-b-time', s.desertBTime);
            settingsSetValue('settings-desert-close-time', s.desertCloseTime || '12:00');
            if (s.scoreMinPoints !== undefined) settingsSetValue('settings-score-min', scoreFmt(s.scoreMinPoints));
            if (s.scoreBelowPenalty !== undefined) settingsSetValue('settings-score-below', s.scoreBelowPenalty);
            if (s.scoreMaxPoints !== undefined) settingsSetValue('settings-score-max', (s.scoreMaxPoints === null) ? '' : scoreFmt(s.scoreMaxPoints));
            if (s.scoreSevereStep !== undefined) settingsSetValue('settings-score-step', scoreFmt(s.scoreSevereStep));
            if (s.scoreMaxCap !== undefined) settingsSetValue('settings-score-cap', s.scoreMaxCap);
            if (s.scoreStreakThreshold !== undefined) settingsSetValue('settings-score-streak', s.scoreStreakThreshold);
          }
        } else {
          if (statusEl) statusEl.textContent = t('common.error') + (data.error || 'unknown error');
        }
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = t('common.error') + err.message;
      });
  }`;
