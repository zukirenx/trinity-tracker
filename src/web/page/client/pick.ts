// Client-side JS: Random train pick tab.
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_PICK: string = `  // ---- Random pick tab ----
  const pickOutput = document.getElementById('pick-output');
  const pickCopyBtn = document.getElementById('pick-copy');
  const pickRollBtn = document.getElementById('pick-roll');
  const pickLoadBtn = document.getElementById('pick-load');
  const pickWrap = document.getElementById('pick-eligible-wrap');
  const pickList = document.getElementById('pick-eligible-list');
  const pickCountLabel = document.getElementById('pick-eligible-count');
  let eligiblePool = [];

  function updateSelectedCount() {
    const checked = pickList.querySelectorAll('input[type=checkbox]:checked').length;
    pickCountLabel.textContent = t('pick.countLabel', { c: checked, e: eligiblePool.length });
    pickRollBtn.disabled = checked === 0;
  }

  function loadEligible() {
    const status = document.getElementById('pick-status');
    const days = Math.max(1, Math.min(365, parseInt(document.getElementById('pick-days').value, 10) || 30));
    status.textContent = t('pick.loading');
    pickOutput.textContent = '';
    pickCopyBtn.classList.add('hidden');
    return api('/api/eligible-train?days=' + days).then(function (res) {
      eligiblePool = (res.entries || []).slice().sort(function (a, b) {
        return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
      });
      pickList.innerHTML = eligiblePool.map(function (m, i) {
        const since = m.daysSinceTrain === null || m.daysSinceTrain === undefined
          ? t('common.never')
          : m.daysSinceTrain + 'd';
        return '<label style="display:flex;align-items:center;gap:.4rem;font-size:.88rem;cursor:pointer">' +
          '<input type="checkbox" data-idx="' + i + '" checked />' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(m.name) + '</span>' +
          '<span class="muted" style="font-size:.75rem">' + since + '</span>' +
          '</label>';
      }).join('');
      pickWrap.classList.toggle('hidden', eligiblePool.length === 0);
      updateSelectedCount();
      status.textContent = eligiblePool.length === 0
        ? t('pick.none', { d: res.minDays })
        : t('pick.uncheck');
    }).catch(function (err) {
      eligiblePool = [];
      pickList.innerHTML = '';
      pickWrap.classList.add('hidden');
      pickRollBtn.disabled = true;
      status.textContent = t('common.error') + err.message;
    });
  }

  function rollPick() {
    const status = document.getElementById('pick-status');
    if (eligiblePool.length === 0) { status.textContent = t('pick.loadFirst'); return; }
    const count = Math.max(1, Math.min(50, parseInt(document.getElementById('pick-count').value, 10) || 5));
    const selected = [];
    pickList.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) {
      const idx = parseInt(cb.dataset.idx, 10);
      if (eligiblePool[idx]) selected.push(eligiblePool[idx]);
    });
    if (selected.length === 0) { status.textContent = t('pick.selectOne'); return; }
    // Fisher–Yates on a copy.
    const pool = selected.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t2 = pool[i]; pool[i] = pool[j]; pool[j] = t2;
    }
    const picked = pool.slice(0, Math.min(count, pool.length));
    const names = picked.map(function (e) { return e.name; });
    pickOutput.textContent = names.join('\\n');
    pickCopyBtn.classList.toggle('hidden', names.length === 0);
    status.textContent = t('pick.picked', { n: names.length, s: selected.length, e: eligiblePool.length });
  }

  pickLoadBtn.addEventListener('click', loadEligible);
  pickRollBtn.addEventListener('click', rollPick);
  pickList.addEventListener('change', function (e) {
    if (e.target && e.target.matches('input[type=checkbox]')) updateSelectedCount();
  });
  document.getElementById('pick-all').addEventListener('click', function () {
    pickList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = true; });
    updateSelectedCount();
  });
  document.getElementById('pick-none').addEventListener('click', function () {
    pickList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
    updateSelectedCount();
  });
  document.getElementById('pick-count').addEventListener('keydown', function (e) { if (e.key === 'Enter') rollPick(); });
  document.getElementById('pick-days').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadEligible(); });`;
