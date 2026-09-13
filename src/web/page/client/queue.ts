// Client-side JS: Train queue tab and bulk moves.
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_QUEUE: string = `  // ---- Train queue tab ----
  let queueInitialized = false;
  let queueData = { queue: [], log: [] };
  const queueSelected = new Set();

  function actionLabel(a) {
    if (a === 'manual-move') return t('queue.action.manual');
    if (a === 'auto-train') return t('queue.action.train');
    if (a === 'add') return t('queue.action.add');
    if (a === 'remove') return t('queue.action.remove');
    if (a === 'merge-move') return t('queue.action.mergeMove');
    if (a === 'merge-remove') return t('queue.action.mergeRemove');
    if (a === 'rename') return t('queue.action.rename');
    return a;
  }
  function actionCellHtml(a) {
    const label = escapeHtml(actionLabel(a));
    if (a === 'merge-move' || a === 'merge-remove') {
      return '<td><span style="background:#3d2952;color:#e0b3ff;padding:.05rem .45rem;border-radius:999px;font-size:.78rem;white-space:nowrap">' + label + '</span></td>';
    }
    if (a === 'rename') {
      return '<td><span style="background:#1f3a5f;color:#a3cfff;padding:.05rem .45rem;border-radius:999px;font-size:.78rem;white-space:nowrap">' + label + '</span></td>';
    }
    return '<td>' + label + '</td>';
  }

  function updateBulkState() {
    if (!IS_ADMIN) return;
    const countEl = document.getElementById('queue-selected-count');
    const upBtn = document.getElementById('queue-bulk-up');
    const downBtn = document.getElementById('queue-bulk-down');
    const endBtn = document.getElementById('queue-bulk-end');
    const n = queueSelected.size;
    countEl.textContent = String(n);
    upBtn.disabled = n === 0;
    downBtn.disabled = n === 0;
    endBtn.disabled = n === 0;
    const selectAll = document.getElementById('queue-select-all');
    if (selectAll) {
      const total = queueData.queue.length;
      selectAll.checked = total > 0 && n === total;
      selectAll.indeterminate = n > 0 && n < total;
    }
  }

  function renderQueue() {
    const tbody = document.querySelector('#queue-table tbody');
    const empty = document.getElementById('queue-empty');
    // Prune selections that are no longer in the queue.
    const presentIds = new Set(queueData.queue.map(function (q) { return q.memberId; }));
    Array.from(queueSelected).forEach(function (id) { if (!presentIds.has(id)) queueSelected.delete(id); });
    if (!queueData.queue || queueData.queue.length === 0) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      const rows = queueData.queue.map(function (q) {
        const checkboxCell = IS_ADMIN
          ? '<td><input type="checkbox" class="queue-select" data-id="' + q.memberId + '"' + (queueSelected.has(q.memberId) ? ' checked' : '') + ' /></td>'
          : '';
        return '<tr>' +
          checkboxCell +
          '<td class="num">' + q.position + '</td>' +
          '<td class="name">' + escapeHtml(q.name) + '</td>' +
          '<td class="num">' + fmtDate(q.lastTrainDate) + '</td>' +
          '<td class="num">' + daysPill(q.daysSinceTrain) + '</td>' +
        '</tr>';
      });
      tbody.innerHTML = rows.join('');
      if (IS_ADMIN) {
        tbody.querySelectorAll('input.queue-select').forEach(function (cb) {
          cb.addEventListener('change', function () {
            const id = Number(cb.dataset.id);
            if (cb.checked) queueSelected.add(id);
            else queueSelected.delete(id);
            updateBulkState();
          });
        });
      }
    }
    const logBody = document.querySelector('#queue-log-table tbody');
    const logEmpty = document.getElementById('queue-log-empty');
    const logCount = document.getElementById('queue-log-count');
    if (logCount) {
      const n = (queueData.log || []).length;
      logCount.textContent = t(n === 1 ? 'queue.log.count.one' : 'queue.log.count.other', { n: n });
    }
    if (!queueData.log || queueData.log.length === 0) {
      logBody.innerHTML = '';
      logEmpty.classList.remove('hidden');
    } else {
      logEmpty.classList.add('hidden');
      // Show newest first (backend already returns DESC order)
      logBody.innerHTML = queueData.log.map(function (e) {
        const range = (e.fromPos !== null && e.toPos !== null)
          ? (e.fromPos + ' → ' + e.toPos)
          : (e.toPos !== null ? '— → ' + e.toPos : (e.fromPos !== null ? e.fromPos + ' → —' : '—'));
        return '<tr>' +
          '<td>' + escapeHtml(e.ts) + '</td>' +
          '<td class="name">' + escapeHtml(e.memberName) + '</td>' +
          actionCellHtml(e.action) +
          '<td class="num">' + range + '</td>' +
          '<td>' + escapeHtml(e.comment || '') + '</td>' +
        '</tr>';
      }).join('');
    }
    updateBulkState();
  }

  function loadQueue(refresh) {
    document.getElementById('queue-status').textContent = refresh ? t('active.fetching') : t('common.loading');
    const qs = refresh && IS_ADMIN ? '?refresh=1' : '';
    return api('/api/queue' + qs).then(function (res) {
      queueData = { queue: res.queue || [], log: res.log || [] };
      renderQueue();
      document.getElementById('queue-status').textContent =
        t('queue.status.summary', { q: queueData.queue.length, l: queueData.log.length });
      var staleWarn = document.getElementById('queue-stale-warning');
      if (staleWarn) {
        var refDate = res.referenceDate ? new Date(res.referenceDate + 'T00:00:00Z') : null;
        var nowUtc = new Date();
        var msPerDay = 86400000;
        var ageDays = refDate ? Math.floor((Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()) - refDate.getTime()) / msPerDay) : null;
        if (ageDays !== null && ageDays > 1) {
          staleWarn.textContent = t('queue.stale', { n: ageDays, s: ageDays === 1 ? '' : 's' });
          staleWarn.classList.remove('hidden');
        } else {
          staleWarn.classList.add('hidden');
        }
      }
    }).catch(function (err) {
      document.getElementById('queue-status').textContent = t('common.error') + err.message;
    });
  }

  function bulkMove(direction) {
    if (queueSelected.size === 0) return;
    const spots = parseInt(document.getElementById('queue-bulk-spots').value, 10);
    if (!Number.isInteger(spots) || spots < 1) {
      window.alert(t('queue.alert.spots'));
      return;
    }
    const names = queueData.queue
      .filter(function (q) { return queueSelected.has(q.memberId); })
      .map(function (q) { return '#' + q.position + ' ' + q.name; })
      .join('\\n');
    const promptKey = direction === 'up' ? 'queue.prompt.up' : 'queue.prompt.down';
    const comment = window.prompt(
      t(promptKey, { n: queueSelected.size, s: spots, names: names }),
      ''
    );
    if (comment === null) return;
    const trimmed = comment.trim();
    if (!trimmed) { window.alert(t('queue.alert.comment')); return; }
    document.getElementById('queue-status').textContent = t('queue.status.moving');
    apiPost('/api/queue/bulk-move', {
      memberIds: Array.from(queueSelected),
      direction: direction,
      spots: spots,
      comment: trimmed,
    })
      .then(function () { queueSelected.clear(); return loadQueue(); })
      .catch(function (err) {
        document.getElementById('queue-status').textContent = t('common.error') + err.message;
      });
  }

  function bulkMoveToEnd() {
    if (queueSelected.size === 0) return;
    const names = queueData.queue
      .filter(function (q) { return queueSelected.has(q.memberId); })
      .map(function (q) { return '#' + q.position + ' ' + q.name; })
      .join('\\n');
    const comment = window.prompt(
      t('queue.prompt.end', { n: queueSelected.size, names: names }),
      ''
    );
    if (comment === null) return;
    const trimmed = comment.trim();
    if (!trimmed) { window.alert(t('queue.alert.comment')); return; }
    document.getElementById('queue-status').textContent = t('queue.status.moving');
    apiPost('/api/queue/move-to-end', {
      memberIds: Array.from(queueSelected),
      comment: trimmed,
    })
      .then(function () { queueSelected.clear(); return loadQueue(); })
      .catch(function (err) {
        document.getElementById('queue-status').textContent = t('common.error') + err.message;
      });
  }

  document.getElementById('queue-refresh').addEventListener('click', function () { loadQueue(true); });
  if (IS_ADMIN) {
    document.getElementById('queue-bulk-up').addEventListener('click', function () { bulkMove('up'); });
    document.getElementById('queue-bulk-down').addEventListener('click', function () { bulkMove('down'); });
    document.getElementById('queue-bulk-end').addEventListener('click', bulkMoveToEnd);
    document.getElementById('queue-bulk-clear').addEventListener('click', function () {
      queueSelected.clear();
      renderQueue();
    });
    const selectAll = document.getElementById('queue-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        if (selectAll.checked) {
          queueData.queue.forEach(function (q) { queueSelected.add(q.memberId); });
        } else {
          queueSelected.clear();
        }
        renderQueue();
      });
    }
  }`;
