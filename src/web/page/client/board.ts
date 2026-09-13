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
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  });`;
