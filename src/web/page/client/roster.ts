// Client-side JS: Events tab: roster builder, suggestion, save/lock, attendance, modals.
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_ROSTER: string = `  function evRenderRegistrations(regs, eventStatus, eventKind) {
    document.getElementById('ev-reg-count').textContent = t('ev.regs.count', { n: regs.length });
    const tbody = document.querySelector('#ev-reg-table tbody');
    tbody.innerHTML = '';
    document.getElementById('ev-reg-empty').classList.toggle('hidden', regs.length > 0);
    var showPrio = eventStatus !== 'locked';
    var prioTh = document.querySelector('#ev-reg-table th[data-i18n="ev.regs.col.prio"]');
    if (prioTh) prioTh.style.display = showPrio ? '' : 'none';
    regs.forEach(function (r) {
      const tr = document.createElement('tr');
      var slotLabel;
      if (r.timeSlot === 'any') {
        slotLabel = t('ev.regs.slotBoth') + (IS_ADMIN && r.resolvedTimeSlot ? ' (' + r.resolvedTimeSlot + ')' : '');
      } else if (r.timeSlot) {
        slotLabel = t('ev.regs.slot') + r.timeSlot;
      } else if (eventKind === 'canyon') {
        // Canyon: team is assigned at suggest time, not at registration.
        // Show resolved team to admins regardless of what's stored in DB.
        var resolvedTeam = r.resolvedTeamPreference || (r.teamPreference !== 'any' ? r.teamPreference : null);
        slotLabel = IS_ADMIN && resolvedTeam ? t('ev.regs.team') + 'any (' + resolvedTeam + ')' : '—';
      } else {
        slotLabel = t('ev.regs.team') + r.teamPreference;
      }
      const teamSlot = slotLabel;
      var cp = r.computedPriority;
      var prioCellHtml;
      if (cp !== null && cp !== undefined && r.status === 'IN' && r.memberActive) {
        var prioVal = cp.toFixed(2);
        var hue = Math.round(cp * 120); // 0→red, 1→green
        var color = 'hsl(' + hue + ',70%,55%)';
        var tooltip = r.priorityRegistered > 0
          ? (r.priorityParticipated + '/' + r.priorityRegistered + ' events') + (r.isTop6 ? ' · top 4' : '')
          : (r.isTop6 ? 'top 4' : 'no history');
        prioCellHtml = '<span style="color:' + color + ';font-weight:600" title="' + escapeHtml(tooltip) + '">' + prioVal + (r.isTop6 ? ' ★' : '') + '</span>';
      } else {
        prioCellHtml = '—';
      }
      tr.innerHTML =
        '<td class="name" style="white-space:nowrap">' + escapeHtml(r.memberName) + (r.memberActive ? '' : ' <span class="pill bad">' + t('ev.regs.inactive') + '</span>') + (r.isBanned ? ' <span class="pill bad">' + t('ev.regs.banBadge') + '</span>' : '') + (r.isPenalized ? ' <span class="pill" style="background:transparent;border:1px solid #f59e0b;color:#f59e0b;font-size:.65rem;font-weight:700" title="' + t('active.penaltyBadge') + '">P</span>' : '') + '</td>' +
        '<td class="num">' + (function() { var ph = r.squadPower ? r.squadPower.toLocaleString() : '\u2014'; if (IS_ADMIN && r.powerSpikeFlag) { var pct = (r.powerChangePercent >= 0 ? '+' : '') + r.powerChangePercent.toFixed(1) + '%'; ph += ' <span title="' + escapeHtml(t('ev.regs.powerSpike', { pct: pct, prev: r.previousPower ? r.previousPower.toLocaleString() : '?' })) + '" style="color:#f59e0b;cursor:help">\u26a0<\/span>'; } if (IS_ADMIN && r.powerDropFlag) { var pct = r.powerChangePercent.toFixed(1) + '%'; ph += ' <span title="' + escapeHtml(t('ev.regs.powerDrop', { pct: pct, prev: r.previousPower ? r.previousPower.toLocaleString() : '?' })) + '" style="color:#ef4444;cursor:help">\u26a0<\/span>'; } return ph; })() + '</td>' +
        '<td>' + escapeHtml(r.squadType) + '</td>' +
        '<td>' + escapeHtml(teamSlot) + '</td>' +
        (showPrio ? '<td>' + prioCellHtml + '</td>' : '') +
        (IS_ADMIN ? '<td class="muted ev-notes-col" style="font-size:.8rem">' + escapeHtml(r.notes || '') + '</td>' : '') +
        '<td class="ev-actions">' + (IS_ADMIN && eventStatus !== 'locked' ? '<button data-mid="' + r.memberId + '" data-banned="' + (r.isBanned ? '1' : '0') + '" class="ev-ban muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:3px;padding:.1rem .4rem;cursor:pointer;font-size:.75rem;margin-right:.25rem">' + (r.isBanned ? t('ev.regs.unban') : t('ev.regs.ban')) + '</button>' : '') + (IS_ADMIN && eventStatus !== 'locked' ? '<button data-mid="' + r.memberId + '" data-penalized="' + (r.isPenalized ? '1' : '0') + '" class="ev-penalize muted" title="' + t('active.penaltyBadge') + '" style="background:transparent;border:1px solid ' + (r.isPenalized ? '#f59e0b' : 'var(--border)') + ';color:' + (r.isPenalized ? '#f59e0b' : 'var(--muted)') + ';border-radius:3px;padding:.1rem .4rem;cursor:pointer;font-size:.75rem;font-weight:700;margin-right:.25rem">P</button>' : '') + (IS_ADMIN ? '<button data-mid="' + r.memberId + '" class="ev-unreg muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:3px;padding:.1rem .4rem;cursor:pointer;font-size:.75rem">×</button>' : '') + '</td>';
      tbody.appendChild(tr);
    });
    if (IS_ADMIN) {
      tbody.querySelectorAll('.ev-ban').forEach(function (b) {
        b.addEventListener('click', function () {
          const mid = Number(b.getAttribute('data-mid'));
          const isBanned = b.getAttribute('data-banned') === '1';
          apiPost('/api/events/ban', { eventId: evCurrentEventId, memberId: mid, banned: !isBanned })
            .then(function () { evLoadEvent(evCurrentEventId); })
            .catch(function (err) { alert('Error: ' + err.message); });
        });
      });
      tbody.querySelectorAll('.ev-penalize').forEach(function (b) {
        b.addEventListener('click', function () {
          const mid = Number(b.getAttribute('data-mid'));
          const isPenalized = b.getAttribute('data-penalized') === '1';
          apiPost('/api/events/penalize', { eventId: evCurrentEventId, memberId: mid, penalized: !isPenalized })
            .then(function () { evLoadEvent(evCurrentEventId); })
            .catch(function (err) { alert('Error: ' + err.message); });
        });
      });
      tbody.querySelectorAll('.ev-unreg').forEach(function (b) {
        b.addEventListener('click', function () {
          const mid = Number(b.getAttribute('data-mid'));
          if (!confirm(t('ev.regs.confirmRemove'))) return;
          apiPost('/api/events/unregister', { eventId: evCurrentEventId, memberId: mid })
            .then(function () { evLoadEvent(evCurrentEventId); })
            .catch(function (err) { alert('Error: ' + err.message); });
        });
      });
    }
  }

  // Build the unified roster state from server-side registrations + assignments.
  // - Anyone with an assignment row → placed on their team in slot order.
  // - Any other IN+active+power>0 registrant → bench.
  // - OUT/MAYBE/inactive/zero-power are NOT shown in the roster editor.
  function evBuildStateFromAssignments(regs, assignments) {
    const regByMember = new Map();
    regs.forEach(function (r) { regByMember.set(r.memberId, r); });
    const state = [];
    const placed = new Set();
    // Sort assignments by team A first, then B, then slot.
    const sorted = assignments.slice().sort(function (x, y) {
      if (x.team !== y.team) return x.team === 'A' ? -1 : 1;
      return x.slotIndex - y.slotIndex;
    });
    sorted.forEach(function (a) {
      const r = regByMember.get(a.memberId);
      state.push({
        memberId: a.memberId,
        memberName: a.memberName,
        power: r ? r.squadPower : 0,
        type: r ? r.squadType : 'tanks',
        team: a.team,
        role: a.role === 'sub' ? 'sub' : 'main',
        strategyRole: a.strategyRole || '',
        strategyRoleCustomized: false,
        isLocked: !!a.isLocked,
        priority: r ? (r.computedPriority ?? null) : null,
        isTop6: r ? !!r.isTop6 : false,
        isBanned: r ? !!r.isBanned : false,
      });
      placed.add(a.memberId);
    });
    regs.forEach(function (r) {
      if (placed.has(r.memberId)) return;
      if (r.status !== 'IN') return;
      if (!r.memberActive) return;
      if (!r.squadPower || r.squadPower <= 0) return;
      if (r.isBanned) return;
      state.push({
        memberId: r.memberId,
        memberName: r.memberName,
        power: r.squadPower,
        type: r.squadType,
        team: 'bench',
        role: null,
        strategyRole: '',
        strategyRoleCustomized: false,
        isLocked: false,
        priority: r.computedPriority ?? null,
        isTop6: !!r.isTop6,
        isBanned: !!r.isBanned,
      });
    });
    return state;
  }

  // Assign strategy roles to all mains in a team, sorted by power desc.
  // Always overwrites — call explicitly from the button or after generate suggestion.
  function evApplyAutoRoles(team) {
    var roleSlots = evCurrentKind === 'desert' ? DS_ROLE_SLOTS : CANYON_ROLE_SLOTS;
    var mains = evRosterState
      .filter(function (r) { return r.team === team && r.role === 'main'; })
      .slice()
      .sort(function (a, b) { return b.power - a.power || a.memberName.localeCompare(b.memberName); });
    mains.forEach(function (row, i) {
      row.strategyRole = i < roleSlots.length ? roleSlots[i] : '';
    });
  }

  function evFormatPower(n) {
    if (!n) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\\.0$/, '') + 'M';
    return n.toLocaleString();
  }

  function evRenderDeadline(iso, status) {
    if (!iso) return '';
    var d = new Date(iso);
    var now = Date.now();
    var closed = d.getTime() < now;
    var label = fmtTimestamp(iso);
    if (closed) {
      var html = '<div>' + t('ev.deadline.closed') + '<span class="pill bad">' + t('ev.deadline.closedBadge') + '</span> <span class="muted" style="font-size:.8rem">' + t('ev.deadline.was', { label: label }) + '</span></div>';
      if (status === 'open') {
        // Registration is over but the roster is still editable: count down
        // to the automatic lock at the next server midnight (02:00 UTC).
        var lockAt = new Date(now);
        lockAt.setUTCHours(2, 0, 0, 0);
        if (lockAt.getTime() <= now) lockAt.setUTCDate(lockAt.getUTCDate() + 1);
        var lockDiff = lockAt.getTime() - now;
        var lockH = Math.floor(lockDiff / 3600000);
        var lockM = Math.floor((lockDiff % 3600000) / 60000);
        var lockLeft = lockH > 0 ? t('ev.deadline.left', { h: lockH, m: lockM }) : t('ev.deadline.leftMin', { m: lockM });
        html += '<div>' + t('ev.deadline.lockLabel') + '<strong>' + fmtTimestamp(lockAt.toISOString()) + '</strong> <span class="pill warn" style="font-size:.7rem">' + lockLeft + '</span></div>';
      }
      return html;
    }
    var diff = d.getTime() - now;
    var hrsLeft = Math.floor(diff / 3600000);
    var minsLeft = Math.floor((diff % 3600000) / 60000);
    var remaining = hrsLeft > 0 ? t('ev.deadline.left', { h: hrsLeft, m: minsLeft }) : t('ev.deadline.leftMin', { m: minsLeft });
    return '<div>' + t('ev.deadline.label') + '<strong>' + label + '</strong> <span class="pill warn" style="font-size:.7rem">' + remaining + '</span></div>';
  }

  // Per-team caps: 20 main + 10 sub.
  const EV_MAIN_PER_TEAM = 20;
  const EV_SUB_PER_TEAM = 10;

  function evRenderRoster(_event) {
    const section = document.getElementById('ev-roster-section');
    section.style.display = '';

    // Sort: keep current order; team A first, then B, then bench.
    // Build per-column lists.
    const colA = [];
    const colB = [];
    const colBench = [];
    evRosterState.forEach(function (row) {
      if (row.team === 'A') colA.push(row);
      else if (row.team === 'B') colB.push(row);
      else colBench.push(row);
    });
    // Bench sorted strongest first for usability.
    colBench.sort(function (x, y) { return y.power - x.power; });

    // Within each team, render mains first (1..20) then subs (21..30) so slot
    // numbers reflect role groups. Sorted by power (strongest first) within each group.
    function orderTeam(rows) {
      var mains = rows.filter(function (r) { return r.role === 'main'; });
      var subs = rows.filter(function (r) { return r.role === 'sub'; });
      mains.sort(function (a, b) { return b.power - a.power; });
      subs.sort(function (a, b) { return b.power - a.power; });
      return mains.concat(subs);
    }
    const orderedA = orderTeam(colA);
    const orderedB = orderTeam(colB);

    function renderRow(row, idx) {
      const isTeam = row.team === 'A' || row.team === 'B';
      const slot = isTeam ? idx + 1 : null;
      const slotCell = isTeam
        ? '<span class="ev-slot">' + slot + '</span>'
        : '';
      const roleBadge = isTeam
        ? '<span class="pill ' + (row.role === 'main' ? 'good' : 'warn') + '" style="font-size:.6rem;flex-shrink:0">' + t('ev.role.' + row.role) + '</span>'
        : '';
      const typePill = '<span class="pill" style="font-size:.6rem;background:var(--panel);color:var(--muted);flex-shrink:0">' + escapeHtml(row.type) + '</span>';
      const powerCell = '<span class="ev-power">' + evFormatPower(row.power) + '</span>';
      const slotOpts = [
        { value: 'A|main', label: t('ev.slot.aMain') },
        { value: 'A|sub', label: t('ev.slot.aSub') },
        { value: 'B|main', label: t('ev.slot.bMain') },
        { value: 'B|sub', label: t('ev.slot.bSub') },
        { value: 'bench|', label: t('ev.slot.bench') },
      ];
      const currentVal = isTeam ? (row.team + '|' + row.role) : 'bench|';
      // Hide the slot select entirely when the roster is locked — no reassignment possible.
      const slotSelect = IS_ADMIN && evCurrentStatus !== 'locked'
        ? '<select class="ev-slot-select" data-mid="' + row.memberId + '"' + (row.isBanned ? ' disabled' : '') + '>' +
          slotOpts.map(function (o) { return '<option value="' + o.value + '"' + (o.value === currentVal ? ' selected' : '') + '>' + o.label + '</option>'; }).join('') +
          '</select>'
        : '';
      const strategyInput = IS_ADMIN && isTeam
        ? '<input type="text" class="ev-strategy-input" data-mid="' + row.memberId + '" value="' + escapeHtml(row.strategyRole) + '" placeholder="' + t('ev.roster.rolePlaceholder') + '" />'
        : (row.strategyRole ? '<span class="muted" style="font-size:.7rem">(' + escapeHtml(row.strategyRole) + ')</span>' : '');
      const lockBadge = row.isLocked ? '<span class="pill warn" style="font-size:.6rem;flex-shrink:0">' + t('ev.roster.locked') + '</span>' : '';
      const banBadge = row.isBanned ? '<span class="pill bad" style="font-size:.6rem;flex-shrink:0">' + t('ev.regs.banBadge') + '</span>' : '';
      // Substitute button: admin only, locked events, assigned (not bench) rows.
      const substituteBtn = IS_ADMIN && evCurrentStatus === 'locked' && isTeam
        ? '<button class="ev-substitute-btn" data-mid="' + row.memberId + '" data-name="' + escapeHtml(row.memberName) + '" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:3px;padding:.1rem .4rem;cursor:pointer;font-size:.75rem;flex-shrink:0">' + t('ev.roster.substitute') + '</button>'
        : '';

      // Attendance checkbox: mains and subs in locked events (admin only).
      // Mains: no-show triggers auto-ban. Subs: tracked for records only, no ban.
      var attendanceCell = '';
      var noShowBadge = '';
      if (IS_ADMIN && evCurrentStatus === 'locked' && isTeam) {
        var isPresent = evAttendanceState.get(row.memberId) === true;
        attendanceCell = '<label title="' + t('ev.attendance.checkTooltip') + '" style="display:flex;align-items:center;gap:.25rem;cursor:pointer;font-size:.75rem;color:var(--muted);flex-shrink:0">' +
          '<input type="checkbox" class="ev-attendance-check" data-mid="' + row.memberId + '"' + (isPresent ? ' checked' : '') + ' style="cursor:pointer" />' +
          '\\u2713</label>';
        if (!isPresent) {
          noShowBadge = '<span class="pill bad ev-noshow-badge" style="font-size:.6rem;flex-shrink:0">' + t('ev.attendance.noShowBadge') + '</span>';
        }
      }

      // Priority badge: show XX% for all rows; omit on admin team rows (they see it in registrations table)
      var prioBadge = '';
      if (row.priority !== null && row.priority !== undefined) {
        var hue = Math.round(row.priority * 120);
        var prioColor = 'hsl(' + hue + ',70%,55%)';
        var prioLabel = row.priority.toFixed(2) + (row.isTop6 ? ' ★' : '');
        if (!isTeam || !IS_ADMIN) {
          prioBadge = '<span class="pill" style="font-size:.6rem;background:var(--panel);color:' + prioColor + ';flex-shrink:0">' + prioLabel + '</span>';
        }
      }

      const cls = isTeam ? ('ev-row ' + row.role) : 'ev-row sub';
      const repeatBench = IS_ADMIN && !isTeam && evPreviousBenched.has(row.memberId);
      const repeatBenchStyle = repeatBench ? ' style="border-left:3px solid #ef4444;background:rgba(239,68,68,.07)"' : '';
      const repeatBenchBadge = repeatBench
        ? '<span class="pill bad" style="font-size:.6rem;flex-shrink:0" title="' + t('ev.roster.repeatBench') + '">2\u00d7</span>'
        : '';
      return '<div class="' + cls + '"' + repeatBenchStyle + '>' +
        '<div class="ev-row-top">' +
          slotCell +
          '<span class="ev-name">' + escapeHtml(row.memberName) + '</span>' +
          powerCell +
          typePill +
        '</div>' +
        '<div class="ev-row-bot">' +
          roleBadge + lockBadge + banBadge + noShowBadge + repeatBenchBadge + prioBadge + strategyInput + slotSelect + substituteBtn + attendanceCell +
        '</div>' +
      '</div>';
    }

    function renderCol(rows, emptyLabel) {
      if (rows.length === 0) {
        return '<div class="muted" style="font-size:.75rem;padding:.5rem;text-align:center">' + emptyLabel + '</div>';
      }
      return rows.map(renderRow).join('');
    }

    document.getElementById('ev-team-a').innerHTML = renderCol(orderedA, t('ev.roster.emptyTeam'));
    document.getElementById('ev-team-b').innerHTML = renderCol(orderedB, t('ev.roster.emptyTeam'));
    document.getElementById('ev-bench').innerHTML = renderCol(colBench, t('ev.roster.emptyBench'));
    function teamPower(rows) {
      return rows.reduce(function (sum, r) { return sum + (r.power || 0); }, 0);
    }
    function teamLabel(rows) {
      const m = rows.filter(function (r) { return r.role === 'main'; }).length;
      const s = rows.filter(function (r) { return r.role === 'sub'; }).length;
      return t('ev.roster.teamCount', { m: m, mc: EV_MAIN_PER_TEAM, s: s, sc: EV_SUB_PER_TEAM });
    }
    document.getElementById('ev-team-a-count').textContent = teamLabel(colA);
    document.getElementById('ev-team-b-count').textContent = teamLabel(colB);
    document.getElementById('ev-team-a-power').textContent = evFormatPower(teamPower(colA));
    document.getElementById('ev-team-b-power').textContent = evFormatPower(teamPower(colB));
    document.getElementById('ev-bench-count').textContent = '(' + colBench.length + ')';

    evSetStatus('ev-roster-status', t('ev.roster.statusAssigned', { a: colA.length + colB.length, b: colBench.length }) + (evRosterDirty ? t('ev.roster.unsaved') : ''));

    const saveBtn = document.getElementById('ev-save-assignments');
    if (saveBtn) saveBtn.disabled = !evRosterDirty;

    // Hide the suggestion button for locked events; strategy role editing stays active.
    var isLockedEvent = evCurrentStatus === 'locked';
    var suggestBtnEl = document.getElementById('ev-suggest');
    if (suggestBtnEl) suggestBtnEl.style.display = isLockedEvent ? 'none' : '';
    if (isLockedEvent && saveBtn) saveBtn.textContent = t('ev.roster.saveRolesOnly');
    else if (!isLockedEvent && saveBtn) saveBtn.setAttribute('data-i18n', 'ev.roster.save');
    // Show Record Attendance button only for locked events (admin).
    var attBtnEl = document.getElementById('ev-record-attendance');
    if (attBtnEl) {
      attBtnEl.style.display = IS_ADMIN && isLockedEvent ? '' : 'none';
      if (evAttendanceRecorded) {
        attBtnEl.title = t('ev.attendance.alreadySaved');
      } else {
        attBtnEl.removeAttribute('title');
      }
    }

    // Wire up edit handlers.
    if (IS_ADMIN) {
      document.querySelectorAll('.ev-slot-select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          const mid = Number(sel.getAttribute('data-mid'));
          const parts = sel.value.split('|');
          const newTeam = parts[0]; // 'A' | 'B' | 'bench'
          const newRole = parts[1] || null; // 'main' | 'sub' | ''
          const row = evRosterState.find(function (x) { return x.memberId === mid; });
          if (!row) return;
          const prevVal = (row.team === 'bench' || !row.role) ? 'bench|' : (row.team + '|' + row.role);
          if (sel.value === prevVal) return;
          // Capacity check per (team, role).
          if (newTeam !== 'bench') {
            const cap = newRole === 'main' ? EV_MAIN_PER_TEAM : EV_SUB_PER_TEAM;
            const count = evRosterState.filter(function (x) {
              return x.memberId !== mid && x.team === newTeam && x.role === newRole;
            }).length;
            if (count >= cap) {
              alert(t('ev.roster.teamFull', { team: newTeam, role: newRole, cap: cap }));
              sel.value = prevVal;
              return;
            }
          }
          var prevTeam = row.team;
          row.team = newTeam;
          row.role = newTeam === 'bench' ? null : newRole;
          row.strategyRole = newTeam === 'bench' ? '' : row.strategyRole;
          // Move to end of its new (team, role) group so order is predictable.
          evRosterState = evRosterState.filter(function (x) { return x.memberId !== mid; }).concat([row]);
          evRosterDirty = true;
          evRenderRoster();
        });
      });
      document.querySelectorAll('.ev-strategy-input').forEach(function (inp) {
        inp.addEventListener('input', function () {
          const mid = Number(inp.getAttribute('data-mid'));
          const row = evRosterState.find(function (x) { return x.memberId === mid; });
          if (!row) return;
          row.strategyRole = inp.value;
          evRosterDirty = true;
          const saveBtn2 = document.getElementById('ev-save-assignments');
          if (saveBtn2) saveBtn2.disabled = false;
        });
      });
      // Attendance checkboxes: update evAttendanceState in real time.
      // Toggle the no-show badge in-place to avoid re-rendering (re-render would
      // stack a new click listener on the attendance button on every checkbox change).
      if (evCurrentStatus === 'locked') {
        document.querySelectorAll('.ev-attendance-check').forEach(function (cb) {
          cb.addEventListener('change', function () {
            const mid = Number(cb.getAttribute('data-mid'));
            evAttendanceState.set(mid, cb.checked);
            var rowBot = cb.closest('.ev-row-bot');
            if (rowBot) {
              var existingBadge = rowBot.querySelector('.ev-noshow-badge');
              if (cb.checked) {
                if (existingBadge) existingBadge.remove();
              } else if (!existingBadge) {
                var badge = document.createElement('span');
                badge.className = 'pill bad ev-noshow-badge';
                badge.style.cssText = 'font-size:.6rem;flex-shrink:0';
                badge.textContent = t('ev.attendance.noShowBadge');
                rowBot.insertBefore(badge, cb.parentElement);
              }
            }
          });
        });
        // Record Attendance button — use onclick so it can never stack multiple handlers.
        var attBtn = document.getElementById('ev-record-attendance');
        if (attBtn) {
          attBtn.onclick = function () {
            var absentMainIds = [];
            var absentSubIds = [];
            evAttendanceState.forEach(function (present, mid) {
              if (!present) {
                var r = evRosterState.find(function (x) { return x.memberId === mid; });
                if (r && r.role === 'main') absentMainIds.push(mid);
                else if (r && r.role === 'sub') absentSubIds.push(mid);
              }
            });
            var presentIds = [];
            evAttendanceState.forEach(function (present, mid) { if (present) presentIds.push(mid); });
            var msg = t('ev.attendance.confirm', { nm: absentMainIds.length, ns: absentSubIds.length });
            if (!confirm(msg)) return;
            apiPost('/api/events/record-attendance', { eventId: evCurrentEventId, presentMemberIds: presentIds })
              .then(function (res) {
                var extra = res.bannedInEventId
                  ? t('ev.attendance.banned', { b: res.bannedCount, id: res.bannedInEventId })
                  : '';
                alert(t('ev.attendance.done', { n: res.noShowIds.length, extra: extra }));
                evLoadEvent(evCurrentEventId);
              })
              .catch(function (err) { alert(t('common.error') + err.message); });
          };
        }
      }

      // Substitute buttons: show modal to replace an assigned player in a locked event.
      document.querySelectorAll('.ev-substitute-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var outMid = Number(btn.getAttribute('data-mid'));
          var outName = btn.getAttribute('data-name') || String(outMid);
          var modal = document.getElementById('ev-sub-modal');
          var titleEl = document.getElementById('ev-sub-modal-title');
          var sel = document.getElementById('ev-sub-in-select');
          var statusEl = document.getElementById('ev-sub-status');
          if (!modal || !sel) return;
          // Populate select with members who are registered IN but NOT currently assigned.
          var assignedIds = new Set(evRosterState.filter(function (r) { return r.team === 'A' || r.team === 'B'; }).map(function (r) { return r.memberId; }));
          var candidates = (evCurrentRegistrations || []).filter(function (r) {
            return r.status === 'IN' && r.memberActive && !assignedIds.has(r.memberId);
          });
          sel.innerHTML = candidates.length === 0
            ? '<option value="" disabled selected>' + escapeHtml(t('ev.roster.substituteSelect')) + '</option>'
            : '<option value="" disabled selected>' + escapeHtml(t('ev.roster.substituteSelect')) + '</option>' +
              candidates.map(function (r) { return '<option value="' + r.memberId + '">' + escapeHtml(r.memberName) + '</option>'; }).join('');
          if (titleEl) titleEl.textContent = t('ev.roster.substituteTitle', { name: outName });
          if (statusEl) statusEl.textContent = '';
          modal.style.display = 'flex';

          var confirmBtn = document.getElementById('ev-sub-confirm');
          var cancelBtn = document.getElementById('ev-sub-cancel');
          function closeModal() { modal.style.display = 'none'; }
          if (cancelBtn) cancelBtn.onclick = closeModal;
          modal.onclick = function (e) { if (e.target === modal) closeModal(); };
          if (confirmBtn) {
            confirmBtn.onclick = function () {
              var inMid = Number(sel.value);
              if (!inMid) { if (statusEl) statusEl.textContent = t('ev.roster.substituteSelect'); return; }
              confirmBtn.disabled = true;
              var inName = sel.options[sel.selectedIndex].text;
              apiPost('/api/events/substitute', { eventId: evCurrentEventId, outMemberId: outMid, inMemberId: inMid })
                .then(function () {
                  closeModal();
                  alert(t('ev.roster.substituteDone', { out: outName, in: inName }));
                  evLoadEvent(evCurrentEventId);
                })
                .catch(function (err) {
                  if (statusEl) statusEl.textContent = t('common.error') + err.message;
                  confirmBtn.disabled = false;
                });
            };
          }
        });
      });
    }
  }

  function evSubmitReg() {
    if (!evCurrentEventId) { evSetStatus('ev-reg-status-msg', t('ev.reg.pickEvent'), 'error'); return; }
    const memberId = Number(document.getElementById('ev-reg-member').value);
    if (!memberId) { evSetStatus('ev-reg-status-msg', t('ev.reg.selectPlayer'), 'error'); return; }
    const powerVal = Number(document.getElementById('ev-reg-power').value);
    if (!powerVal || powerVal <= 0) { evSetStatus('ev-reg-status-msg', t('ev.reg.enterPower'), 'error'); return; }
    const ev = evEvents.find(function (e) { return e.id === evCurrentEventId; });
    const slotVal = ev && ev.kind === 'desert' ? document.getElementById('ev-reg-slot').value : null;
    if (ev && ev.kind === 'desert' && !slotVal) { evSetStatus('ev-reg-status-msg', t('ev.reg.slotPlaceholder'), 'error'); return; }
    const body = {
      eventId: evCurrentEventId,
      memberId: memberId,
      status: 'IN',
      squadPower: Math.round(powerVal * 1000000),
      squadType: document.getElementById('ev-reg-type').value,
      teamPreference: document.getElementById('ev-reg-team').value,
      timeSlot: slotVal,
      notes: document.getElementById('ev-reg-notes').value || null,
    };
    evSetStatus('ev-reg-status-msg', t('ev.reg.saving'));
    apiPost('/api/events/register', body).then(function () {
      evSetStatus('ev-reg-status-msg', t('ev.reg.saved'), 'good');
      evLoadEvent(evCurrentEventId);
    }).catch(function (err) {
      evSetStatus('ev-reg-status-msg', t('common.error') + err.message, 'error');
    });
  }

  function evRunSuggest() {
    if (!evCurrentEventId) return;
    evSetStatus('ev-roster-status', t('ev.roster.generating'));
    apiPost('/api/events/suggest-roster', { eventId: evCurrentEventId, commit: false })
      .then(function (res) {
        evLastSuggestion = res;
        document.getElementById('ev-warnings').textContent = (res.warnings || []).join(' • ');
        // Build state: suggested players placed on their team; everyone else
        // who's IN+active+power>0 goes to the bench.
        const pseudoAssignments = (res.assignments || []).map(function (a) {
          return {
            memberId: a.memberId, memberName: a.memberName,
            team: a.team, role: a.role, slotIndex: a.slotIndex,
            strategyRole: a.strategyRole || null, isLocked: false,
          };
        });
        evRosterState = evBuildStateFromAssignments(evCurrentRegistrations, pseudoAssignments);
        // Server already set roles; no customization on a fresh suggest.
        evApplyAutoRoles('A');
        evApplyAutoRoles('B');
        evRosterDirty = true;
        evRenderRoster();
        evSetStatus('ev-roster-status', t('ev.roster.suggested'));
      })
      .catch(function (err) { evSetStatus('ev-roster-status', t('common.error') + err.message, 'error'); });
  }

  function evSaveAssignments() {
    if (!evCurrentEventId) return;
    // Slot numbering: mains 1..20, subs 21..30, per team, in current state order.
    const counters = { A: { main: 0, sub: 0 }, B: { main: 0, sub: 0 } };
    const payload = [];
    evRosterState.forEach(function (row) {
      if (row.team !== 'A' && row.team !== 'B') return;
      if (row.role !== 'main' && row.role !== 'sub') return;
      counters[row.team][row.role] += 1;
      const offset = row.role === 'main' ? 0 : 20;
      const slot = offset + counters[row.team][row.role];
      payload.push({
        memberId: row.memberId,
        team: row.team,
        role: row.role,
        slotIndex: slot,
        strategyRole: row.strategyRole || null,
      });
    });
    evSetStatus('ev-roster-status', t('ev.reg.saving'));
    apiPost('/api/events/assignments', { eventId: evCurrentEventId, assignments: payload })
      .then(function () {
        evRosterDirty = false;
        evSetStatus('ev-roster-status', t('ev.reg.saved'), 'good');
        evLoadEvent(evCurrentEventId);
      })
      .catch(function (err) { evSetStatus('ev-roster-status', t('common.error') + err.message, 'error'); });
  }

  // Compact phone-friendly roster: mains only, one team at a time, full width —
  // each row shows the full strategy-role name (including admin-typed custom
  // roles), so nothing is ever truncated away. Screenshot one team, switch to
  // the other, screenshot again.
  var evCompactTeam = 'A';

  function evShowCompact() {
    if (!evCurrentEventId) return;
    evRenderCompactTeam(evCompactTeam === 'B' ? 'B' : 'A');
    var modal = document.getElementById('ev-compact-modal');
    if (modal) modal.style.display = '';
  }

  function evRenderCompactTeam(teamKey) {
    evCompactTeam = teamKey;
    var titleEl = document.getElementById('ev-compact-title');
    var listEl = document.getElementById('ev-compact-team');
    var btnA = document.getElementById('ev-compact-team-a');
    var btnB = document.getElementById('ev-compact-team-b');
    if (!titleEl || !listEl) return;
    var kindLabel = evCurrentKind === 'desert' ? t('ev.kind.desert') : t('ev.kind.canyon');
    var teamName = t(teamKey === 'B' ? 'ev.roster.teamB' : 'ev.roster.teamA');
    titleEl.textContent = kindLabel + ' \u2014 ' + teamName;
    var roleSlots = evCurrentKind === 'desert' ? DS_ROLE_SLOTS : CANYON_ROLE_SLOTS;
    var mains = evRosterState
      .filter(function (r) { return r.team === teamKey && r.role === 'main'; })
      .sort(function (a, b) { return b.power - a.power; });
    var items = mains.map(function (row, i) {
      var role = row.strategyRole || roleSlots[i] || 'main';
      return '<div style="border-bottom:1px solid var(--border);padding:.17rem 0;font-size:.8rem;line-height:1.35">' +
        '<span class="muted">' + (i + 1) + '.</span> ' +
        '<strong>' + escapeHtml(row.memberName) + '</strong> ' +
        '<span class="muted">\u2014 ' + escapeHtml(role) + '</span>' +
        '</div>';
    }).join('');
    if (!items) items = '<div class="muted" style="font-size:.78rem">' + t('ev.roster.compactEmpty') + '</div>';
    listEl.innerHTML = items;
    // Toggle buttons: highlight the visible team. onclick assignment (not
    // addEventListener) so re-renders never stack handlers.
    var pairs = [[btnA, 'A'], [btnB, 'B']];
    pairs.forEach(function (pair) {
      var btn = pair[0];
      var key = pair[1];
      if (!btn) return;
      btn.onclick = function () { evRenderCompactTeam(key); };
      var selected = key === teamKey;
      btn.style.background = selected ? 'var(--accent)' : 'transparent';
      btn.style.color = selected ? '#0d1117' : 'var(--text)';
      btn.style.borderColor = selected ? 'transparent' : 'var(--border)';
    });
  }

  function evHideCompact() {
    var modal = document.getElementById('ev-compact-modal');
    if (modal) modal.style.display = 'none';
  }
`;
