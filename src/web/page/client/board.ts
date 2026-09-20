// Client-side JS: Leaderboard history tab and upload flow (incl. missing-members review).
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_BOARD: string = `  // ---- Leaderboard tab ----
  let boardInitialized = false;
  const boardTable = makeTable({
    table: document.getElementById('board-table'),
    empty: document.getElementById('board-empty'),
    defaultSort: 'rank',
    defaultDir: 'asc',
    defaultDirFor: function (key) { return key === 'commander' ? 'asc' : (key === 'points' ? 'desc' : 'asc'); },
    row: function (e) {
      return '<tr>' +
        '<td class="num">' + e.rank + '</td>' +
        '<td class="name">' + escapeHtml(e.commander) + '</td>' +
        '<td class="num">' + (typeof e.points === 'number' ? e.points.toLocaleString() : '') + '</td>' +
        '</tr>';
    },
  });

  function formatBoardLabel(b) {
    const title = b.title || b.slug;
    if (b.title && b.slug && b.slug !== b.title) return title + ' [' + b.slug + ']';
    return title;
  }

  // Apply the most recent leaderboard's title/slug as the placeholder example
  // in the Upload tab. Called whenever the leaderboard list is refreshed.
  function applyUploadExamples(latest) {
    if (!latest) return;
    const titleInput = document.getElementById('upload-title');
    const slugInput = document.getElementById('upload-slug');
    if (titleInput && latest.title) titleInput.placeholder = 'e.g. ' + latest.title;
    if (slugInput && latest.slug) slugInput.placeholder = 'e.g. ' + latest.slug;
  }

  var BASE_OCR_PROMPT = 'These are screenshots of leaderboard in the Last War online game. Parse them and create a table in JSON format containing this leaderboard, using the fields Ranking, Commander, and Points. Return only the JSON array, without any commentary.';

  let uploadExamplesLoaded = false;
  function ensureUploadExamples() {
    if (uploadExamplesLoaded) return Promise.resolve();
    uploadExamplesLoaded = true;
    return Promise.all([
      api('/api/leaderboards'),
      api('/api/active'),
    ]).then(function (results) {
      const list = (results[0].leaderboards || []);
      if (list.length) applyUploadExamples(list[0]);
      const names = (results[1].entries || [])
        .map(function (e) { return e.name || ''; })
        .filter(function (n) { return n && /[^ -~]/.test(n); })
        .sort(function (a, b) { return a.localeCompare(b); });
      const promptEl = document.getElementById('upload-prompt');
      if (promptEl) {
        promptEl.textContent = names.length
          ? BASE_OCR_PROMPT + '\\n\\nSome member names contain special characters — use exact spelling and casing when you recognise one of these on screen:\\n' + names.join(', ')
          : BASE_OCR_PROMPT;
      }
    }).catch(function () { uploadExamplesLoaded = false; });
  }

  function loadBoardList() {
    const status = document.getElementById('board-status');
    const select = document.getElementById('board-select');
    const deleteBtn = document.getElementById('board-delete');
    status.textContent = t('board.loadingList');
    return api('/api/leaderboards').then(function (res) {
      const list = res.leaderboards || [];
      if (list.length === 0) {
        select.innerHTML = '';
        boardTable.setData([]);
        deleteBtn.disabled = true;
        status.textContent = t('board.noStored');
        return;
      }
      select.innerHTML = list.map(function (b) {
        return '<option value="' + escapeHtml(b.slug) + '">' + escapeHtml(formatBoardLabel(b)) + '</option>';
      }).join('');
      select.value = list[0].slug;
      deleteBtn.disabled = false;
      applyUploadExamples(list[0]);
      return loadBoard(list[0].slug);
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  }

  function loadBoard(slug) {
    const status = document.getElementById('board-status');
    status.textContent = t('board.loadingOne');
    return api('/api/leaderboard?slug=' + encodeURIComponent(slug)).then(function (res) {
      const entries = res.entries || [];
      boardTable.setData(entries);
      const meta = res.leaderboard;
      const label = meta ? formatBoardLabel(meta) : slug;
      status.textContent = t('board.summary', { n: entries.length, label: label });
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  }

  document.getElementById('board-select').addEventListener('change', function (e) {
    if (e.target.value) loadBoard(e.target.value);
  });
  document.getElementById('board-refresh').addEventListener('click', function () {
    const select = document.getElementById('board-select');
    if (select.value) loadBoard(select.value); else loadBoardList();
  });
  document.getElementById('board-delete').addEventListener('click', function () {
    const select = document.getElementById('board-select');
    const slug = select.value;
    if (!slug) return;
    const label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].text : slug;
    if (!window.confirm(t('board.confirmDelete', { label: label }))) return;
    const status = document.getElementById('board-status');
    status.textContent = t('board.deleting');
    apiPost('/api/delete-leaderboard', { slug: slug }).then(function () {
      status.textContent = t('board.deleted');
      loadBoardList();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });
  pickCopyBtn.addEventListener('click', function () {
    const text = pickOutput.textContent || '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        const original = pickCopyBtn.textContent;
        pickCopyBtn.textContent = t('common.copied');
        setTimeout(function () { pickCopyBtn.textContent = original; }, 1200);
      });
    } else {
      const range = document.createRange();
      range.selectNodeContents(pickOutput);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  // ---- Upload leaderboard tab ----
  let uploadCommanders = [];
  let uploadMissing = [];
  let lastUploadedSlug = null;

  document.getElementById('upload-prompt-copy').addEventListener('click', function () {
    const btn = document.getElementById('upload-prompt-copy');
    const text = document.getElementById('upload-prompt').textContent || '';
    const done = function () {
      const orig = btn.textContent;
      btn.textContent = t('common.copied');
      setTimeout(function () { btn.textContent = orig; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('upload-prompt'));
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
      });
    } else {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('upload-prompt'));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
  });

  function parseUploadJson() {
    const raw = document.getElementById('upload-json').value.trim();
    if (!raw) throw new Error('JSON is empty.');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('Invalid JSON: ' + e.message); }
    if (!Array.isArray(parsed)) throw new Error('JSON root must be an array.');
    if (parsed.length === 0) throw new Error('JSON array is empty.');
    // Pre-validate structure, contiguous ranks, and non-increasing points.
    const rows = [];
    for (let i = 0; i < parsed.length; i++) {
      const e = parsed[i];
      const rank = Number(e && (e.rank != null ? e.rank : (e.Ranking != null ? e.Ranking : e.ranking)));
      const commander = String((e && (e.commander != null ? e.commander : e.Commander)) || '').trim();
      const points = Number(e && (e.points != null ? e.points : e.Points));
      if (!isFinite(rank) || rank < 1) throw new Error('Entry ' + (i + 1) + ': invalid rank.');
      if (!commander) throw new Error('Entry ' + (i + 1) + ': missing commander.');
      if (!isFinite(points) || points < 0) throw new Error('Entry ' + (i + 1) + ': invalid points.');
      rows.push({ rank: Math.floor(rank), commander: commander, points: Math.floor(points) });
    }
    rows.sort(function (a, b) { return a.rank - b.rank; });
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].rank !== i + 1) {
        throw new Error('Ranks must be contiguous starting from 1. Expected ' + (i + 1) + ' but found ' + rows[i].rank + '. The JSON looks incomplete.');
      }
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].points > rows[i - 1].points) {
        throw new Error('Points must be non-increasing by rank. Rank ' + rows[i].rank + ' (' + rows[i].points + ') > rank ' + rows[i - 1].rank + ' (' + rows[i - 1].points + ').');
      }
    }
    return parsed;
  }

  function renderMissingList() {
    const wrap = document.getElementById('upload-missing-wrap');
    const list = document.getElementById('upload-missing-list');
    if (uploadMissing.length === 0) {
      wrap.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    wrap.classList.remove('hidden');
    const optsHtml = uploadCommanders.slice().sort(function (a, b) {
      return a.commander.toLowerCase().localeCompare(b.commander.toLowerCase());
    }).map(function (c) {
      return '<option value="' + escapeHtml(c.normalized) + '">' + escapeHtml(c.commander) + '</option>';
    }).join('');
    list.innerHTML = uploadMissing.map(function (m) {
      return '<div data-id="' + m.id + '" style="display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.4rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--panel-2)">' +
        '<strong style="flex:1;min-width:10rem">' + escapeHtml(m.displayName) + '</strong>' +
        '<label style="font-size:.85rem;display:flex;align-items:center;gap:.25rem"><input type="radio" name="act-' + m.id + '" value="keep" checked /> ' + escapeHtml(t('upload.keep')) + '</label>' +
        '<label style="font-size:.85rem;display:flex;align-items:center;gap:.25rem"><input type="radio" name="act-' + m.id + '" value="remove" /> ' + escapeHtml(t('upload.markInactive')) + '</label>' +
        '<label style="font-size:.85rem;display:flex;align-items:center;gap:.25rem"><input type="radio" name="act-' + m.id + '" value="merge" /> ' + escapeHtml(t('upload.mergeInto')) + '</label>' +
        '<select data-merge-target style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.25rem .4rem;font-size:.85rem;min-width:12rem">' +
          '<option value="">' + escapeHtml(t('upload.chooseCommander')) + '</option>' + optsHtml +
        '</select>' +
        '</div>';
    }).join('');
  }

  document.getElementById('upload-submit').addEventListener('click', function () {
    const status = document.getElementById('upload-status');
    const title = document.getElementById('upload-title').value.trim();
    const slug = document.getElementById('upload-slug').value.trim();
    if (!title) { status.textContent = t('upload.enterName'); return; }
    if (!slug) { status.textContent = t('upload.enterSlug'); return; }
    let entries;
    try { entries = parseUploadJson(); }
    catch (e) { status.textContent = e.message; return; }
    status.textContent = t('upload.uploading', { n: entries.length });
    apiPost('/api/upload-leaderboard', {
      slug: slug, title: title, source: 'web-interface', entries: entries,
    }).then(function (res) {
      uploadCommanders = res.commanders || [];
      uploadMissing = res.missingActiveMembers || [];      lastUploadedSlug = res.slug || null;      status.textContent = t('upload.uploaded', { n: res.inserted || 0 }) +
        (uploadMissing.length === 0
          ? t('upload.allPresent')
          : t('upload.missingCount', { n: uploadMissing.length }));
      renderMissingList();
      boardInitialized = false;
      loadScorePending();
      // Score review starts once name maintenance is done. When nobody is
      // missing, that is right now; otherwise it opens after Apply decisions.
      if (uploadMissing.length === 0 && lastUploadedSlug) openScoreDialog(lastUploadedSlug);
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  document.getElementById('upload-apply').addEventListener('click', function () {
    const status = document.getElementById('upload-apply-status');
    const rows = document.querySelectorAll('#upload-missing-list > div[data-id]');
    const decisions = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const id = parseInt(row.dataset.id, 10);
      const checked = row.querySelector('input[type=radio]:checked');
      const action = checked ? checked.value : 'keep';
      if (action === 'merge') {
        const target = row.querySelector('select[data-merge-target]').value;
        if (!target) {
          status.textContent = t('upload.pickMerge', { name: row.querySelector('strong').textContent });
          return;
        }
        decisions.push({ id: id, action: 'merge', targetNormalized: target });
      } else if (action === 'remove') {
        decisions.push({ id: id, action: 'remove' });
      }
    }
    if (decisions.length === 0) {
      status.textContent = t('upload.noActions');
      uploadMissing = [];
      renderMissingList();
      loadScorePending();
      if (lastUploadedSlug) openScoreDialog(lastUploadedSlug);
      return;
    }
    status.textContent = t('upload.applying', { n: decisions.length });
    apiPost('/api/leaderboard-maintenance', { decisions: decisions }).then(function (res) {
      const results = res.results || [];
      const ok = results.filter(function (r) { return r.ok; }).length;
      const fail = results.length - ok;
      status.textContent = t('upload.done', { ok: ok, fail: fail > 0 ? t('upload.failed', { n: fail }) : '' });
      const applied = new Set(results.filter(function (r) { return r.ok; }).map(function (r) { return r.id; }));
      uploadMissing = uploadMissing.filter(function (m) { return !applied.has(m.id); });
      renderMissingList();
      loadScorePending();
      // All names resolved -> open the score review for queue penalties / DS bans.
      if (uploadMissing.length === 0 && lastUploadedSlug) openScoreDialog(lastUploadedSlug);
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  document.getElementById('upload-discard').addEventListener('click', function () {
    const status = document.getElementById('upload-apply-status');
    if (!lastUploadedSlug) { status.textContent = t('upload.nothingDiscard'); return; }
    if (!window.confirm(t('upload.confirmDiscard', { slug: lastUploadedSlug }))) return;
    status.textContent = t('upload.discarding');
    apiPost('/api/delete-leaderboard', { slug: lastUploadedSlug }).then(function () {
      status.textContent = t('upload.discarded', { slug: lastUploadedSlug });
      lastUploadedSlug = null;
      uploadCommanders = [];
      uploadMissing = [];
      renderMissingList();
      boardInitialized = false;
      loadScorePending();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  // ---- Score review: queue penalties + regular-offender DS bans ----
  // Opens after missing-members are resolved; resumable via the pending banner.
  var scoreSlug = null;
  var scorePreview = null;
  // Canonical key of the inputs the current preview was built from. Apply and
  // Confirm bans stay disabled until a preview matches the CURRENT inputs, so
  // the admin can never apply something different from what was shown.
  var scorePreviewKey = null;
  var scoreDefaults = { minPoints: 7200000, belowMinPenalty: 1, maxPoints: null, severeStep: 1000000, maxCap: 5, streakThreshold: 2 };
  var scoreReviewState = { penaltiesStatus: 'pending', bansStatus: 'pending' };

  function scoreConfigKey() {
    var ids = ['score-min-enabled', 'score-min-points', 'score-below-penalty',
      'score-max-enabled', 'score-max-points', 'score-severe-step', 'score-max-cap',
      'score-streak-threshold'];
    var parts = [scoreSlug];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el) { parts.push(''); continue; }
      parts.push(el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    }
    return parts.join('|');
  }

  function scorePreviewFresh() {
    return !!scorePreview && scorePreviewKey !== null && scorePreviewKey === scoreConfigKey();
  }

  // Any settings change invalidates the shown preview: hide it and force the
  // admin back through Preview before Apply / Confirm bans become available.
  function scoreMarkStale() {
    if (!scorePreview && scorePreviewKey === null) { scoreSetButtons(); return; }
    scorePreview = null;
    scorePreviewKey = null;
    document.getElementById('score-preview-wrap').classList.add('hidden');
    document.getElementById('score-regulars-wrap').classList.add('hidden');
    document.getElementById('score-status').textContent = t('score.previewStale');
    scoreSetButtons();
  }

  function fmtPointsInput(n) {
    if (n === null || n === undefined) return '';
    if (!isFinite(n)) return '';
    if (n >= 1000000) {
      var m = n / 1000000;
      var s = m >= 100 ? String(Math.round(m)) : String(Math.round(m * 10) / 10);
      return s + 'M';
    }
    if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
    return String(n);
  }

  function parsePointsLoose(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().replace(/\\s+/g, '').replace(',', '.');
    if (s === '') return null;
    var m = s.match(/^(\\d+(?:\\.\\d+)?)([mMkK]?)$/);
    if (!m) return NaN;
    var base = Number(m[1]);
    if (!isFinite(base)) return NaN;
    var mult = m[2].toLowerCase() === 'm' ? 1000000 : (m[2].toLowerCase() === 'k' ? 1000 : 1);
    return Math.floor(base * mult);
  }

  function scoreCollectConfig() {
    var minOn = document.getElementById('score-min-enabled').checked;
    var maxOn = document.getElementById('score-max-enabled').checked;
    var minPts = parsePointsLoose(document.getElementById('score-min-points').value);
    var maxPts = parsePointsLoose(document.getElementById('score-max-points').value);
    var belowN = parseInt(document.getElementById('score-below-penalty').value, 10);
    var step = parsePointsLoose(document.getElementById('score-severe-step').value);
    var cap = parseInt(document.getElementById('score-max-cap').value, 10);
    var streak = parseInt(document.getElementById('score-streak-threshold').value, 10);
    if (minOn && (minPts === null || !isFinite(minPts) || minPts < 0)) throw new Error(t('score.errMin'));
    if (maxOn && maxPts !== null && (!isFinite(maxPts) || maxPts < 0)) throw new Error(t('score.errMax'));
    if (maxOn && maxPts === null) throw new Error(t('score.errMaxEmpty'));
    if (minOn && (!Number.isInteger(belowN) || belowN < 1 || belowN > 50)) throw new Error(t('score.errBelowN'));
    if (maxOn && (step === null || !isFinite(step) || step < 1)) throw new Error(t('score.errStep'));
    if (maxOn && (!Number.isInteger(cap) || cap < 1 || cap > 50)) throw new Error(t('score.errCap'));
    if (!Number.isInteger(streak) || streak < 1 || streak > 25) throw new Error(t('score.errStreak'));
    if (minOn && maxOn && maxPts !== null && minPts > maxPts) throw new Error(t('score.errMinMax'));
    return {
      minEnabled: minOn, minPoints: minPts === null ? scoreDefaults.minPoints : minPts,
      belowMinPenalty: Number.isInteger(belowN) && belowN >= 1 ? belowN : scoreDefaults.belowMinPenalty,
      maxEnabled: maxOn, maxPoints: maxOn ? maxPts : null,
      severeStep: step === null ? scoreDefaults.severeStep : step,
      maxCap: Number.isInteger(cap) && cap >= 1 ? cap : scoreDefaults.maxCap,
      streakThreshold: streak,
    };
  }

  function scoreApplyDefaultsToInputs() {
    document.getElementById('score-min-points').value = fmtPointsInput(scoreDefaults.minPoints);
    document.getElementById('score-below-penalty').value = String(scoreDefaults.belowMinPenalty);
    document.getElementById('score-max-points').value = scoreDefaults.maxPoints === null ? '' : fmtPointsInput(scoreDefaults.maxPoints);
    document.getElementById('score-severe-step').value = fmtPointsInput(scoreDefaults.severeStep);
    document.getElementById('score-max-cap').value = String(scoreDefaults.maxCap);
    document.getElementById('score-streak-threshold').value = String(scoreDefaults.streakThreshold);
    document.getElementById('score-min-enabled').checked = false;
    document.getElementById('score-max-enabled').checked = false;
    scoreToggleInputs();
  }

  function scoreToggleInputs() {
    var minOn = document.getElementById('score-min-enabled').checked;
    var maxOn = document.getElementById('score-max-enabled').checked;
    ['score-min-points', 'score-below-penalty'].forEach(function (id) {
      var el = document.getElementById(id);
      el.disabled = !minOn;
      el.style.opacity = minOn ? '' : '0.5';
    });
    ['score-max-points', 'score-severe-step', 'score-max-cap'].forEach(function (id) {
      var el = document.getElementById(id);
      el.disabled = !maxOn;
      el.style.opacity = maxOn ? '' : '0.5';
    });
  }

  function scoreSetButtons() {
    var applyBtn = document.getElementById('score-apply-btn');
    var bansBtn = document.getElementById('score-bans-confirm-btn');
    var fresh = scorePreviewFresh();
    var hasPreview = !!scorePreview;
    var canApply = fresh && scorePreview.penalties.length > 0 &&
      scoreReviewState.penaltiesStatus === 'pending' && !scorePreview.alreadyApplied;
    applyBtn.disabled = !canApply;
    applyBtn.style.opacity = canApply ? '' : '0.5';
    var regularCount = hasPreview ? scorePreview.regulars.length : 0;
    var canBan = fresh && regularCount > 0 && scoreReviewState.bansStatus === 'pending';
    bansBtn.disabled = !canBan;
    bansBtn.style.opacity = canBan ? '' : '0.5';
    // Skipping needs no preview: always available while anything is pending.
    var skipAllBtn = document.getElementById('score-skip-all-btn');
    var canSkipAll = scoreReviewState.penaltiesStatus === 'pending' || scoreReviewState.bansStatus === 'pending';
    skipAllBtn.disabled = !canSkipAll;
    skipAllBtn.style.opacity = canSkipAll ? '' : '0.5';
  }

  function scoreRenderPreview() {
    var wrap = document.getElementById('score-preview-wrap');
    var empty = document.getElementById('score-preview-empty');
    var tbody = document.querySelector('#score-preview-table tbody');
    var regsWrap = document.getElementById('score-regulars-wrap');
    var regsList = document.getElementById('score-regulars-list');
    if (!scorePreview) {
      wrap.classList.add('hidden');
      regsWrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    var pens = scorePreview.penalties || [];
    if (pens.length === 0) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      tbody.innerHTML = pens.map(function (p) {
        var reason = p.reason === 'below-min' ? t('score.reasonBelowMin') : t('score.reasonAboveMax');
        if (p.capped) reason += ' ' + t('score.cappedBadge');
        return '<tr><td class="name">' + escapeHtml(p.commander) + '</td>' +
          '<td class="num">' + p.points.toLocaleString() + '</td>' +
          '<td class="num">-' + p.penalty + '</td>' +
          '<td>' + escapeHtml(reason) + '</td></tr>';
      }).join('');
    }
    // Regular offenders with checkboxes (all checked by default). The section
    // stays visible while bans are still pending even with zero regulars, so
    // the admin always has a Skip bans button to clear the review.
    var regs = scorePreview.regulars || [];
    var bansOpen = scoreReviewState.bansStatus === 'pending';
    if (regs.length === 0 && !bansOpen) {
      regsWrap.classList.add('hidden');
      regsList.innerHTML = '';
    } else {
      regsWrap.classList.remove('hidden');
      regsList.innerHTML = regs.length === 0
        ? '<div class="muted" style="font-size:.85rem">' + escapeHtml(t('score.regularsEmpty')) + '</div>'
        : regs.map(function (r) {
          var badge = r.alreadyBanned ? ' <span class="pill bad">' + escapeHtml(t('score.alreadyBanned')) + '</span>' : '';
          var sub = escapeHtml(r.commander) + ' <span class="muted">· ' + r.points.toLocaleString() + ' · ' +
            t('score.streakRow', { n: r.streak }) + '</span>' + badge;
          return '<label style="display:flex;align-items:center;gap:.5rem;padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--panel-2);font-size:.85rem;cursor:pointer">' +
            '<input type="checkbox" data-mid="' + (r.memberId === null ? '' : r.memberId) + '" checked /> ' + sub + '</label>';
        }).join('');
    }
    // DS target note: bans hit ONLY the next open-registration DS, exactly once.
    var note = document.getElementById('score-ds-note');
    var tgt = scorePreview.targetDesert;
    var closed = scorePreview.closedDesert;
    if (regs.length > 0) {
      var html = '';
      if (tgt) {
        html += t('score.dsNoteTarget', { week: tgt.weekStart, closes: tgt.registrationClosesAt || '—' });
      } else {
        html += t('score.dsNoteQueued');
      }
      if (closed) html += ' ' + t('score.dsNoteClosed', { week: closed.weekStart });
      note.textContent = html;
    }
    scoreSetButtons();
  }

  function scoreDoPreview() {
    var status = document.getElementById('score-status');
    var cfg;
    try { cfg = scoreCollectConfig(); }
    catch (e) { status.textContent = e.message; return Promise.resolve(); }
    if (!scoreSlug) { status.textContent = t('score.errNoSlug'); return Promise.resolve(); }
    if (!cfg.minEnabled && !cfg.maxEnabled) { status.textContent = t('score.errNoRule'); return Promise.resolve(); }
    status.textContent = t('score.previewing');
    return apiPost('/api/leaderboard-score-preview', { slug: scoreSlug, config: cfg }).then(function (res) {
      scorePreview = res;
      scorePreviewKey = scoreConfigKey();
      if (res.review) scoreReviewState = res.review;
      if (res.review && res.review.penaltiesStatus !== 'pending') {
        status.textContent = t(res.review.penaltiesStatus === 'done' ? 'score.alreadyApplied' : 'score.penaltiesSkipped');
      } else if ((res.penalties || []).length === 0) {
        status.textContent = t('score.previewEmpty');
      } else {
        status.textContent = t('score.previewDone', { n: (res.penalties || []).length });
      }
      scoreRenderPreview();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  }

  function openScoreDialog(slug) {
    scoreSlug = slug;
    scorePreview = null;
    scorePreviewKey = null;
    document.getElementById('score-slug-label').textContent = slug ? '(' + slug + ')' : '';
    document.getElementById('score-status').textContent = '';
    document.getElementById('score-bans-status').textContent = '';
    document.getElementById('score-preview-wrap').classList.add('hidden');
    document.getElementById('score-regulars-wrap').classList.add('hidden');
    scoreSetButtons();
    var dlg = document.getElementById('upload-score-dialog');
    if (dlg && dlg.showModal) { try { if (!dlg.open) dlg.showModal(); } catch (e) { /* ignore */ } }
    // Load saved defaults + review state, then present a clean (disabled-by-default) form.
    api('/api/leaderboard-score-status?slug=' + encodeURIComponent(slug)).then(function (res) {
      if (res.defaults) {
        scoreDefaults = {
          minPoints: res.defaults.minPoints,
          belowMinPenalty: res.defaults.belowMinPenalty,
          maxPoints: res.defaults.maxPoints,
          severeStep: res.defaults.severeStep,
          maxCap: res.defaults.maxCap,
          streakThreshold: res.defaults.streakThreshold,
        };
      }
      if (res.review) scoreReviewState = res.review;
      if (slug !== scoreSlug) return;
      scoreApplyDefaultsToInputs();
      var st = document.getElementById('score-status');
      if (scoreReviewState.penaltiesStatus === 'done') st.textContent = t('score.alreadyApplied');
      else if (scoreReviewState.penaltiesStatus === 'skipped') st.textContent = t('score.penaltiesSkipped');
      var bs = document.getElementById('score-bans-status');
      if (scoreReviewState.bansStatus === 'done') bs.textContent = t('score.bansAlreadyDone');
      else if (scoreReviewState.bansStatus === 'skipped') bs.textContent = t('score.bansSkipped');
      scoreSetButtons();
    }).catch(function () {
      scoreApplyDefaultsToInputs();
    });
  }

  // Any settings change invalidates the shown preview (Apply / Confirm bans
  // stay disabled until Preview is pressed again). The streak threshold
  // re-previews immediately instead, so it refreshes rather than stales.
  ['score-min-enabled', 'score-min-points', 'score-below-penalty',
   'score-max-enabled', 'score-max-points', 'score-severe-step', 'score-max-cap'
  ].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () {
      scoreToggleInputs();
      scoreMarkStale();
    });
  });
  document.getElementById('score-streak-threshold').addEventListener('change', function () {
    if (scoreSlug && document.getElementById('upload-score-dialog').open) scoreDoPreview();
  });
  document.getElementById('score-preview-btn').addEventListener('click', scoreDoPreview);

  document.getElementById('score-apply-btn').addEventListener('click', function () {
    var status = document.getElementById('score-status');
    if (!scorePreviewFresh()) { status.textContent = t('score.previewStale'); scoreSetButtons(); return; }
    var cfg;
    try { cfg = scoreCollectConfig(); }
    catch (e) { status.textContent = e.message; return; }
    status.textContent = t('score.applying');
    apiPost('/api/leaderboard-score-apply', { slug: scoreSlug, config: cfg }).then(function (res) {
      var moves = res.moves || [];
      var skipped = res.skipped || [];
      status.textContent = t('score.appliedDone', { n: moves.length }) +
        (skipped.length > 0 ? ' ' + t('score.appliedSkipped', { n: skipped.length }) : '');
      scoreReviewState.penaltiesStatus = 'done';
      if (res.bansAutoSkipped) {
        scoreReviewState.bansStatus = 'skipped';
        document.getElementById('score-bans-status').textContent = t('score.bansSkipped');
      }
      scoreSetButtons();
      loadScorePending();
      if (queueInitialized) loadQueue();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  document.getElementById('score-skip-btn').addEventListener('click', function () {
    var status = document.getElementById('score-status');
    status.textContent = t('score.skipping');
    apiPost('/api/leaderboard-score-skip', { slug: scoreSlug, scope: 'penalties' }).then(function () {
      status.textContent = t('score.penaltiesSkipped');
      scoreReviewState.penaltiesStatus = 'skipped';
      scoreSetButtons();
      loadScorePending();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  document.getElementById('score-bans-confirm-btn').addEventListener('click', function () {
    var status = document.getElementById('score-bans-status');
    if (!scorePreviewFresh()) { status.textContent = t('score.previewStale'); scoreSetButtons(); return; }
    var boxes = document.querySelectorAll('#score-regulars-list input[type=checkbox]:checked');
    var ids = [];
    for (var i = 0; i < boxes.length; i++) {
      var v = parseInt(boxes[i].getAttribute('data-mid'), 10);
      if (Number.isInteger(v) && v > 0) ids.push(v);
    }
    var cfg;
    try { cfg = scoreCollectConfig(); }
    catch (e) { status.textContent = e.message; return; }
    status.textContent = t('score.bansApplying');
    apiPost('/api/leaderboard-score-bans', { slug: scoreSlug, config: cfg, memberIds: ids }).then(function (res) {
      var parts = [];
      if ((res.bannedNow || []).length > 0) parts.push(t('score.bansBannedNow', { n: res.bannedNow.length }));
      if ((res.queued || []).length > 0) parts.push(t('score.bansQueued', { n: res.queued.length }));
      if ((res.alreadyBanned || []).length > 0) parts.push(t('score.bansAlready', { n: res.alreadyBanned.length }));
      status.textContent = parts.length > 0 ? parts.join(' ') : t('score.bansNone');
      scoreReviewState.bansStatus = 'done';
      scoreSetButtons();
      loadScorePending();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  document.getElementById('score-bans-skip-btn').addEventListener('click', function () {
    var status = document.getElementById('score-bans-status');
    status.textContent = t('score.skipping');
    apiPost('/api/leaderboard-score-skip', { slug: scoreSlug, scope: 'bans' }).then(function () {
      status.textContent = t('score.bansSkipped');
      scoreReviewState.bansStatus = 'skipped';
      scoreSetButtons();
      loadScorePending();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  document.getElementById('score-skip-all-btn').addEventListener('click', function () {
    var status = document.getElementById('score-status');
    if (!window.confirm(t('score.skipAllConfirm'))) return;
    status.textContent = t('score.skipping');
    apiPost('/api/leaderboard-score-skip', { slug: scoreSlug, scope: 'all' }).then(function () {
      if (scoreReviewState.penaltiesStatus === 'pending') {
        scoreReviewState.penaltiesStatus = 'skipped';
        status.textContent = t('score.penaltiesSkipped');
      }
      if (scoreReviewState.bansStatus === 'pending') {
        scoreReviewState.bansStatus = 'skipped';
        document.getElementById('score-bans-status').textContent = t('score.bansSkipped');
      }
      scoreSetButtons();
      loadScorePending();
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });

  document.getElementById('score-close-btn').addEventListener('click', function () {
    var dlg = document.getElementById('upload-score-dialog');
    if (dlg && dlg.open) dlg.close();
    loadScorePending();
  });

  // ---- Unfinished score reviews banner ----
  function loadScorePending() {
    var wrap = document.getElementById('upload-pending-wrap');
    var list = document.getElementById('upload-pending-list');
    if (!wrap || !list || !IS_ADMIN) return Promise.resolve();
    return api('/api/leaderboard-score-pending').then(function (res) {
      var pending = res.pending || [];
      if (pending.length === 0) {
        wrap.classList.add('hidden');
        list.innerHTML = '';
        return;
      }
      wrap.classList.remove('hidden');
      list.innerHTML = pending.map(function (p) {
        var label = p.title && p.title !== p.slug ? p.title + ' [' + p.slug + ']' : p.slug;
        var state = [];
        if (p.penaltiesStatus === 'pending') state.push(t('score.statePenalties'));
        if (p.bansStatus === 'pending') state.push(t('score.stateBans'));
        return '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.4rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--panel)">' +
          '<strong style="flex:1;min-width:12rem">' + escapeHtml(label) + '</strong>' +
          '<span class="muted" style="font-size:.8rem">' + escapeHtml(state.join(' · ')) + '</span>' +
          '<button type="button" data-resume="' + escapeHtml(p.slug) + '" style="background:var(--accent);border:none;color:#0d1117;border-radius:4px;padding:.35rem .8rem;cursor:pointer;font-weight:600;font-size:.85rem">' + escapeHtml(t('score.resume')) + '</button>' +
          '</div>';
      }).join('');
      list.querySelectorAll('button[data-resume]').forEach(function (btn) {
        btn.addEventListener('click', function () { openScoreDialog(btn.getAttribute('data-resume')); });
      });
    }).catch(function () { /* banner is best-effort; upload still works */ });
  }

  document.getElementById('upload-pending-refresh').addEventListener('click', loadScorePending);`;
