// Client-side JS: Events tab: loading, detail, registrations.
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_EVENTS: string = `  // ---- Events tab ----
  let evInitialized = false;
  let evEvents = [];
  var DS_ROLE_SLOTS = [
    'assassin / silo', 'assassin / arsenal',
    'hospital 1 / silo', 'hospital 2 / mercenary', 'hospital 3 / arsenal', 'hospital 4 / mercenary',
    'oil 1', 'oil 2', 'science', 'infos',
    'hospital 1', 'hospital 2', 'hospital 3', 'hospital 4',
    'oil 1', 'oil 2',
    'hospital 1', 'hospital 2', 'hospital 3', 'hospital 4',
  ];
  var CANYON_ROLE_SLOTS = [
    'power tower / virus lab', 'power tower / virus lab', 'power tower / virus lab',
    'power tower / virus lab', 'power tower / virus lab', 'power tower / virus lab',
    'sample warehouse 2 / sample warehouse 3', 'defense system 1 / sample warehouse 1',
    'defense system 2 / sample warehouse 4', 'data center 1 / serum factory 2',
    'data center 2 / serum factory 1', 'sample warehouse 2 / sample warehouse 3',
    'defense system 1 / sample warehouse 1', 'defense system 2 / sample warehouse 4',
    'data center 1 / serum factory 2', 'data center 2 / serum factory 1',
    'defense system 1 / sample warehouse 1', 'defense system 2 / sample warehouse 4',
    'data center 1 / serum factory 2', 'data center 2 / serum factory 1',
  ];
  let evCurrentEventId = null;
  let evCurrentStatus = null;
  let evCurrentKind = null;
  let evActiveMembers = [];
  let evLastSuggestion = null;
  let evCurrentRegistrations = [];
  // Roster state: array of {memberId, memberName, power, type, team:'A'|'B'|'bench', strategyRole}
  // Order within team A or B becomes the slot_index (1-30). Role auto-derives:
  // 1..20 = main, 21..30 = sub.
  let evRosterState = [];
  let evRosterDirty = false;
  // Set of memberId numbers who were benched (rejected) in the previous locked event of the same kind.
  let evPreviousBenched = new Set();
  // Attendance tracking for locked events: memberId → true (present) / false (no-show).
  let evAttendanceState = new Map();
  // Whether attendance has already been saved for the current locked event.
  let evAttendanceRecorded = false;

  function evSetStatus(id, msg, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'error' ? '#ff6b6b' : kind === 'good' ? '#4ade80' : '';
  }

  function evInit() {
    document.getElementById('ev-refresh').addEventListener('click', evLoadEvents);
    // Compact phone-friendly view: available to everyone with roster access.
    var compactBtn = document.getElementById('ev-compact');
    if (compactBtn) compactBtn.addEventListener('click', evShowCompact);
    var compactClose = document.getElementById('ev-compact-close');
    if (compactClose) compactClose.addEventListener('click', evHideCompact);
    var compactModal = document.getElementById('ev-compact-modal');
    if (compactModal) compactModal.addEventListener('click', function (e) {
      if (e.target === compactModal) evHideCompact();
    });    document.getElementById('ev-event-select').addEventListener('change', function () {
      const v = this.value ? Number(this.value) : null;
      evCurrentEventId = v;
      if (v != null) evLoadEvent(v);
    });
    document.getElementById('ev-reg-submit').addEventListener('click', evSubmitReg);
    if (IS_ADMIN) {
      const suggestBtn = document.getElementById('ev-suggest');
      if (suggestBtn) suggestBtn.addEventListener('click', evRunSuggest);
      const saveBtn = document.getElementById('ev-save-assignments');
      if (saveBtn) saveBtn.addEventListener('click', evSaveAssignments);
      const exportBtn = document.getElementById('ev-export-regs');
      if (exportBtn) exportBtn.addEventListener('click', evExportRegs);
      const exportTeamsBtn = document.getElementById('ev-export-teams');
      if (exportTeamsBtn) exportTeamsBtn.addEventListener('click', evExportTeams);
      const postDiscordBtn = document.getElementById('ev-post-discord');
      if (postDiscordBtn) postDiscordBtn.addEventListener('click', evPostDiscord);
      const assignRolesBtn = document.getElementById('ev-assign-roles');
      if (assignRolesBtn) assignRolesBtn.addEventListener('click', function () {
        evApplyAutoRoles('A');
        evApplyAutoRoles('B');
        evRosterDirty = true;
        evRenderRoster();
      });
    }
    evLoadEvents();
    evLoadActiveMembers();
  }

  function evExportRegs() {
    if (!evCurrentRegistrations || evCurrentRegistrations.length === 0) return;
    var header = [t('ev.regs.col.player'), t('ev.regs.col.power'), t('ev.regs.col.type'), t('ev.regs.col.teamSlot'), t('ev.regs.col.notes')].join('\\t');
    var rows = evCurrentRegistrations.map(function (r) {
      var teamSlot;
      if (r.timeSlot === 'any') {
        teamSlot = t('ev.regs.slotBoth') + (r.resolvedTimeSlot ? ' (' + r.resolvedTimeSlot + ')' : '');
      } else if (r.timeSlot) {
        teamSlot = t('ev.regs.slot') + r.timeSlot;
      } else if (evCurrentKind === 'canyon') {
        var resolvedTeamExp = r.resolvedTeamPreference || (r.teamPreference !== 'any' ? r.teamPreference : null);
        teamSlot = resolvedTeamExp ? 'any (' + resolvedTeamExp + ')' : 'any';
      } else {
        teamSlot = t('ev.regs.team') + r.teamPreference;
      }
      var power = r.squadPower ? String(r.squadPower) : '';
      return [r.memberName, power, r.squadType, teamSlot, r.notes || ''].join('\\t');
    });
    var tsv = header + '\\n' + rows.join('\\n');
    navigator.clipboard.writeText(tsv).then(function () {
      var btn = document.getElementById('ev-export-regs');
      if (!btn) return;
      var orig = btn.textContent;
      btn.textContent = t('common.copied');
      setTimeout(function () { btn.textContent = orig; }, 1500);
    });
  }

  function evPostDiscord() {
    if (!evCurrentEventId) return;
    var btn = document.getElementById('ev-post-discord');
    if (btn) { btn.textContent = '...'; btn.setAttribute('disabled', 'true'); }
    var doPost = function () {
      apiPost('/api/events/post-roster', { eventId: evCurrentEventId })
        .then(function () {
          if (btn) { btn.textContent = t('common.copied'); setTimeout(function () { btn.textContent = t('ev.roster.postDiscord'); btn.removeAttribute('disabled'); }, 2000); }
        })
        .catch(function (err) {
          if (btn) { btn.textContent = t('ev.roster.postDiscord'); btn.removeAttribute('disabled'); }
          alert('Discord post failed: ' + err.message);
        });
    };
    if (evRosterDirty) {
      // Auto-save unsaved role edits so the Discord post reflects the current UI state.
      const counters = { A: { main: 0, sub: 0 }, B: { main: 0, sub: 0 } };
      const payload = [];
      evRosterState.forEach(function (row) {
        if (row.team !== 'A' && row.team !== 'B') return;
        if (row.role !== 'main' && row.role !== 'sub') return;
        counters[row.team][row.role] += 1;
        const offset = row.role === 'main' ? 0 : 20;
        const slot = offset + counters[row.team][row.role];
        payload.push({ memberId: row.memberId, team: row.team, role: row.role, slotIndex: slot, strategyRole: row.strategyRole || null });
      });
      apiPost('/api/events/assignments', { eventId: evCurrentEventId, assignments: payload })
        .then(function () { evRosterDirty = false; doPost(); })
        .catch(function (err) {
          if (btn) { btn.textContent = t('ev.roster.postDiscord'); btn.removeAttribute('disabled'); }
          alert('Save failed before Discord post: ' + err.message);
        });
    } else {
      doPost();
    }
  }

  function evExportTeams() {
    if (!evRosterState || evRosterState.length === 0) return;
    var lines = [];
    for (var _t of ['A', 'B']) {
      lines.push('Team ' + _t);
      lines.push(['Player', 'Role', 'Power'].join('\\t'));
      var members = evRosterState.filter(function (r) { return r.team === _t; })
        .slice().sort(function (a, b) { return (b.power || 0) - (a.power || 0); });
      members.forEach(function (r) {
        var role = r.role === 'sub' ? 'sub' : (r.strategyRole || r.role || '');
        lines.push([r.memberName, role, r.power || ''].join('\\t'));
      });
      lines.push('');
    }
    var tsv = lines.join('\\n');
    navigator.clipboard.writeText(tsv).then(function () {
      var btn = document.getElementById('ev-export-teams');
      if (!btn) return;
      var orig = btn.textContent;
      btn.textContent = t('common.copied');
      setTimeout(function () { btn.textContent = orig; }, 1500);
    });
  }

  function evLoadEvents() {
    evSetStatus('ev-event-status', t('common.loading'));
    return api('/api/events').then(function (data) {
      evEvents = data.events || [];
      const sel = document.getElementById('ev-event-select');
      sel.innerHTML = '';
      if (evEvents.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = t('ev.noEvents');
        sel.appendChild(opt);
        evSetStatus('ev-event-status', '');
        evCurrentEventId = null;
        document.getElementById('ev-event-meta').style.display = 'none';
        document.getElementById('ev-roster-section').style.display = 'none';
        return;
      }
      evEvents.forEach(function (ev) {
        const opt = document.createElement('option');
        opt.value = String(ev.id);
        var kindLabel = ev.kind === 'canyon' ? t('ev.kind.canyon') : t('ev.kind.desert');
        opt.textContent = (ev.notes ? ev.notes : kindLabel + ' \u2014 week ' + ev.weekStart) +
          ' [' + ev.status + ']';
        sel.appendChild(opt);
      });
      // Keep current selection if still present, else pick first.
      const keep = evEvents.find(function (e) { return e.id === evCurrentEventId; });
      if (keep) sel.value = String(keep.id);
      else { evCurrentEventId = evEvents[0].id; sel.value = String(evCurrentEventId); }
      evSetStatus('ev-event-status', '');
      evLoadEvent(evCurrentEventId);
    }).catch(function (err) {
      evSetStatus('ev-event-status', t('common.error') + err.message, 'error');
    });
  }

  function evLoadActiveMembers() {
    return api('/api/events/active-members').then(function (data) {
      evActiveMembers = data.members || [];
      evActiveMembers.sort(function (a, b) { return a.name.localeCompare(b.name); });
      const sel = document.getElementById('ev-reg-member');
      sel.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = t('ev.reg.selectPlayer');
      sel.appendChild(placeholder);
      evActiveMembers.forEach(function (m) {
        const opt = document.createElement('option');
        opt.value = String(m.id);
        opt.textContent = m.name;
        sel.appendChild(opt);
      });
    }).catch(function () { /* silent */ });
  }

  function evLoadEvent(id) {
    evSetStatus('ev-event-status', t('ev.loadingEvent'));
    return api('/api/events/detail?id=' + encodeURIComponent(id)).then(function (data) {
      const ev = data.event;
      const meta = document.getElementById('ev-event-meta');
      meta.style.display = '';
      meta.innerHTML =
        '<div style="display:flex;flex-wrap:wrap;gap:.5rem 1.2rem;font-size:.85rem">' +
        '<div><strong>' + (ev.kind === 'canyon' ? t('ev.kind.canyon') : t('ev.kind.desert')) + '</strong></div>' +
        '<div>' + t('ev.meta.weekStart') + escapeHtml(ev.weekStart) + '</div>' +
        '<div>' + t('ev.meta.status') + '<span class="pill ' + (ev.status === 'open' ? 'good' : 'warn') + '">' + ev.status + '</span></div>' +
        (ev.teamAStartsAt ? '<div>' + t('ev.meta.teamA') + escapeHtml(fmtTimestamp(ev.teamAStartsAt)) + '</div>' : '') +
        (ev.teamBStartsAt ? '<div>' + t('ev.meta.teamB') + escapeHtml(fmtTimestamp(ev.teamBStartsAt)) + '</div>' : '') +
        evRenderDeadline(ev.registrationClosesAt, ev.status) +
        '</div>';
      // Hide registration form for non-admins when registrations are closed.
      var regClosed = ev.registrationClosesAt && new Date(ev.registrationClosesAt).getTime() < Date.now();
      document.getElementById('ev-reg-form-section').style.display = (CAN_REGISTER && (IS_ADMIN || !regClosed)) ? '' : 'none';
      // Canyon: team preference is always 'any' (hidden). Desert: show time slot.
      document.getElementById('ev-reg-team-wrap').style.display = 'none';
      document.getElementById('ev-reg-slot-wrap').style.display = ev.kind === 'desert' ? '' : 'none';
      document.getElementById('ev-reg-slot').value = '';
      evCurrentKind = ev.kind;
      evCurrentRegistrations = data.registrations || [];
      evRenderRegistrations(evCurrentRegistrations, ev.status, ev.kind);
      evLastSuggestion = null;
      evRosterDirty = false;
      evCurrentStatus = ev.status;
      evPreviousBenched = new Set(data.previousBenched || []);
      evAttendanceRecorded = !!(ev.attendanceRecorded);
      // Initialise attendance state from the participation log outcomes.
      // For locked events: played-main → present (true), no-show → absent (false).
      // If attendance hasn't been recorded yet, default all mains to present (true).
      evAttendanceState = new Map();
      if (ev.status === 'locked') {
        var outcomes = data.outcomes || {};
        (data.assignments || []).forEach(function (a) {
          if (a.role === 'main' || a.role === 'sub') {
            var outcome = outcomes[a.memberId];
            // If attendance was already recorded, load the saved state.
            // Otherwise default to unchecked — admin must tick each player who showed up.
            if (ev.attendanceRecorded) {
              evAttendanceState.set(a.memberId, outcome !== 'no-show');
            } else {
              evAttendanceState.set(a.memberId, false);
            }
          }
        });
      }
      evRosterState = evBuildStateFromAssignments(evCurrentRegistrations, data.assignments || []);
      evRenderRoster(ev);
      evSetStatus('ev-event-status', '');
    }).catch(function (err) {
      evSetStatus('ev-event-status', t('common.error') + err.message, 'error');
    });
  }`;
