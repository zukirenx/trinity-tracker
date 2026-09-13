// Client-side JS: Active-players tab and member add/remove/rename/merge dialogs.
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_ACTIVE: string = `  // ---- Active tab ----
  const activeTable = makeTable({
    table: document.getElementById('active-table'),
    empty: document.getElementById('active-empty'),
    defaultSort: 'daysSinceTrain',
    defaultDir: 'desc',
    defaultDirFor: function (key) { return key === 'name' ? 'asc' : 'desc'; },
    row: function (m) {
      return '<tr>' +
        '<td class="name">' + escapeHtml(m.name) + '</td>' +
        '<td class="num">' + fmtDate(m.lastTrainDate) + '</td>' +
        '<td class="num">' + fmtDate(m.lastVipDate) + '</td>' +
        '<td class="num">' + daysPill(m.daysSinceTrain) + '</td>' +
        '<td class="num">' + daysPill(m.daysSinceVip) + '</td>' +
        '</tr>';
    },
  });

  let activeMembersCache = [];
  let activeMembersIdMap = {};
  function loadActive(refresh) {
    const status = document.getElementById('active-status');
    status.textContent = refresh ? t('active.fetching') : t('common.loading');
    const qs = refresh ? '?refresh=1' : '';
    return api('/api/active' + qs).then(function (res) {
      activeTable.setData(res.entries || []);
      activeMembersCache = (res.entries || []).map(function (m) { return m.name; }).sort(function (a, b) {
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
      });
      activeMembersIdMap = {};
      (res.entries || []).forEach(function (m) { activeMembersIdMap[m.name] = m.id; });
      let msg = t('active.summary', { n: (res.entries || []).length });
      if (res.ingested && res.ingested.ingested) {
        msg += t('active.ingested', { n: res.ingested.count });
      } else if (refresh) {
        msg += t('active.noNew');
      }
      status.textContent = msg;
      document.getElementById('last-updated').textContent =
        res.referenceDate ? t('app.reference') + res.referenceDate : '';
    }).catch(function (err) {
      status.textContent = t('common.error') + err.message;
    });
  }
  document.getElementById('active-refresh').addEventListener('click', function () { loadActive(true); });

  const activeMergeBtn = document.getElementById('active-merge');
  const activeMergeDialog = document.getElementById('active-merge-dialog');
  const activeMergeForm = document.getElementById('active-merge-form');
  const activeMergeTargetSel = document.getElementById('active-merge-target');
  const activeMergeDuplicateSel = document.getElementById('active-merge-duplicate');
  const activeMergeError = document.getElementById('active-merge-error');
  const activeMergeCancelBtn = document.getElementById('active-merge-cancel');

  function populateMergeSelects(preselectTarget, preselectDuplicate) {
    if (!activeMergeTargetSel || !activeMergeDuplicateSel) return;
    const placeholder = '<option value="" disabled' +
      (preselectTarget || preselectDuplicate ? '' : ' selected') +
      '>' + escapeHtml(t('active.merge.choose')) + '</option>';
    const options = activeMembersCache.map(function (name) {
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
    }).join('');
    activeMergeTargetSel.innerHTML = placeholder + options;
    activeMergeDuplicateSel.innerHTML = placeholder + options;
    if (preselectTarget) activeMergeTargetSel.value = preselectTarget;
    if (preselectDuplicate) activeMergeDuplicateSel.value = preselectDuplicate;
  }

  if (activeMergeBtn && activeMergeDialog) {
    activeMergeBtn.addEventListener('click', function () {
      if (!activeMembersCache.length) {
        const status = document.getElementById('active-status');
        status.textContent = t('common.loading');
        loadActive(false).then(function () {
          if (!activeMembersCache.length) return;
          populateMergeSelects();
          activeMergeError.textContent = '';
          const pocChkEarly = document.getElementById('active-merge-poc-duplicate');
          if (pocChkEarly) pocChkEarly.checked = false;
          if (typeof activeMergeDialog.showModal === 'function') activeMergeDialog.showModal();
          else activeMergeDialog.setAttribute('open', '');
        });
        return;
      }
      populateMergeSelects();
      activeMergeError.textContent = '';
      const pocChk = document.getElementById('active-merge-poc-duplicate');
      if (pocChk) pocChk.checked = false;
      if (typeof activeMergeDialog.showModal === 'function') activeMergeDialog.showModal();
      else activeMergeDialog.setAttribute('open', '');
    });
  }
  if (activeMergeCancelBtn && activeMergeDialog) {
    activeMergeCancelBtn.addEventListener('click', function () {
      if (typeof activeMergeDialog.close === 'function') activeMergeDialog.close();
      else activeMergeDialog.removeAttribute('open');
    });
  }
  if (activeMergeForm) {
    activeMergeForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const target = (activeMergeTargetSel.value || '').trim();
      const duplicate = (activeMergeDuplicateSel.value || '').trim();
      if (!target || !duplicate) {
        activeMergeError.textContent = t('active.merge.pickBoth');
        return;
      }
      if (target === duplicate) {
        activeMergeError.textContent = t('active.merge.sameName');
        return;
      }
      activeMergeError.textContent = '';
      const status = document.getElementById('active-status');
      status.textContent = t('active.merge.merging');
      const pocDuplicateChk = document.getElementById('active-merge-poc-duplicate');
      const pocSource = (pocDuplicateChk && pocDuplicateChk.checked) ? 'duplicate' : 'target';
      apiPost('/api/merge-members', { target: target, duplicate: duplicate, pocSource: pocSource })
        .then(function () {
          status.textContent = t('active.merge.done', { target: target, duplicate: duplicate });
          if (typeof activeMergeDialog.close === 'function') activeMergeDialog.close();
          else activeMergeDialog.removeAttribute('open');
          loadActive(false);
          if (typeof queueInitialized !== 'undefined' && queueInitialized) loadQueue();
        })
        .catch(function (err) {
          activeMergeError.textContent = err.message;
          status.textContent = t('common.error') + err.message;
        });
    });
  }

  // ---- Add player ----
  const activeAddBtn = document.getElementById('active-add');
  if (activeAddBtn) {
    activeAddBtn.addEventListener('click', function () {
      const raw = window.prompt(t('active.add.prompt'), '');
      if (raw === null) return;
      const name = raw.trim();
      const status = document.getElementById('active-status');
      if (!name) {
        window.alert(t('active.add.empty'));
        return;
      }
      status.textContent = t('active.add.adding');
      apiPost('/api/add-member', { name: name })
        .then(function () {
          status.textContent = t('active.add.done', { name: name });
          loadActive(false);
          if (typeof queueInitialized !== 'undefined' && queueInitialized) loadQueue();
        })
        .catch(function (err) {
          status.textContent = t('common.error') + err.message;
        });
    });
  }

  // ---- Remove player ----
  const activeRemoveBtn = document.getElementById('active-remove');
  const activeRemoveDialog = document.getElementById('active-remove-dialog');
  const activeRemoveForm = document.getElementById('active-remove-form');
  const activeRemoveSelect = document.getElementById('active-remove-select');
  const activeRemoveError = document.getElementById('active-remove-error');
  const activeRemoveCancelBtn = document.getElementById('active-remove-cancel');

  function populateRemoveSelect() {
    if (!activeRemoveSelect) return;
    const placeholder = '<option value="" disabled selected>' +
      escapeHtml(t('active.remove.choose')) + '</option>';
    const options = activeMembersCache.map(function (name) {
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
    }).join('');
    activeRemoveSelect.innerHTML = placeholder + options;
  }

  function openRemoveDialog() {
    populateRemoveSelect();
    if (activeRemoveError) activeRemoveError.textContent = '';
    if (typeof activeRemoveDialog.showModal === 'function') activeRemoveDialog.showModal();
    else activeRemoveDialog.setAttribute('open', '');
  }

  if (activeRemoveBtn && activeRemoveDialog) {
    activeRemoveBtn.addEventListener('click', function () {
      if (!activeMembersCache.length) {
        const status = document.getElementById('active-status');
        status.textContent = t('common.loading');
        loadActive(false).then(function () {
          if (!activeMembersCache.length) return;
          openRemoveDialog();
        });
        return;
      }
      openRemoveDialog();
    });
  }
  if (activeRemoveCancelBtn && activeRemoveDialog) {
    activeRemoveCancelBtn.addEventListener('click', function () {
      if (typeof activeRemoveDialog.close === 'function') activeRemoveDialog.close();
      else activeRemoveDialog.removeAttribute('open');
    });
  }
  if (activeRemoveForm) {
    activeRemoveForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const name = (activeRemoveSelect.value || '').trim();
      if (!name) {
        activeRemoveError.textContent = t('active.remove.pickName');
        return;
      }
      if (!window.confirm(t('active.remove.confirm', { name: name }))) return;
      activeRemoveError.textContent = '';
      const status = document.getElementById('active-status');
      status.textContent = t('active.remove.removing');
      apiPost('/api/remove-member', { name: name })
        .then(function () {
          status.textContent = t('active.remove.done', { name: name });
          if (typeof activeRemoveDialog.close === 'function') activeRemoveDialog.close();
          else activeRemoveDialog.removeAttribute('open');
          loadActive(false);
          if (typeof queueInitialized !== 'undefined' && queueInitialized) loadQueue();
        })
        .catch(function (err) {
          activeRemoveError.textContent = err.message;
          status.textContent = t('common.error') + err.message;
        });
    });
  }

  // ---- Rename player ----
  const activeRenameBtn = document.getElementById('active-rename');
  const activeRenameDialog = document.getElementById('active-rename-dialog');
  const activeRenameForm = document.getElementById('active-rename-form');
  const activeRenameSelect = document.getElementById('active-rename-select');
  const activeRenameNewName = document.getElementById('active-rename-newname');
  const activeRenameError = document.getElementById('active-rename-error');
  const activeRenameCancelBtn = document.getElementById('active-rename-cancel');

  function populateRenameSelect(preselect) {
    if (!activeRenameSelect) return;
    const placeholder = '<option value="" disabled' + (preselect ? '' : ' selected') + '>' +
      escapeHtml(t('active.rename.choose')) + '</option>';
    const options = activeMembersCache.map(function (name) {
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
    }).join('');
    activeRenameSelect.innerHTML = placeholder + options;
    if (preselect) activeRenameSelect.value = preselect;
  }

  function openRenameDialog() {
    populateRenameSelect();
    if (activeRenameNewName) activeRenameNewName.value = '';
    if (activeRenameError) activeRenameError.textContent = '';
    if (typeof activeRenameDialog.showModal === 'function') activeRenameDialog.showModal();
    else activeRenameDialog.setAttribute('open', '');
  }

  if (activeRenameBtn && activeRenameDialog) {
    activeRenameBtn.addEventListener('click', function () {
      if (!activeMembersCache.length) {
        const status = document.getElementById('active-status');
        status.textContent = t('common.loading');
        loadActive(false).then(function () {
          if (!activeMembersCache.length) return;
          openRenameDialog();
        });
        return;
      }
      openRenameDialog();
    });
  }
  if (activeRenameCancelBtn && activeRenameDialog) {
    activeRenameCancelBtn.addEventListener('click', function () {
      if (typeof activeRenameDialog.close === 'function') activeRenameDialog.close();
      else activeRenameDialog.removeAttribute('open');
    });
  }
  if (activeRenameForm) {
    activeRenameForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const name = (activeRenameSelect.value || '').trim();
      const newName = (activeRenameNewName.value || '').trim();
      if (!name) {
        activeRenameError.textContent = t('active.rename.pickName');
        return;
      }
      if (!newName) {
        activeRenameError.textContent = t('active.rename.emptyName');
        return;
      }
      const memberId = activeMembersIdMap[name];
      if (!memberId) {
        activeRenameError.textContent = t('common.error') + 'member id not found';
        return;
      }
      activeRenameError.textContent = '';
      const status = document.getElementById('active-status');
      status.textContent = t('active.rename.renaming');
      apiPost('/api/rename-member', { id: memberId, newName: newName })
        .then(function () {
          status.textContent = t('active.rename.done', { name: name, newName: newName });
          if (typeof activeRenameDialog.close === 'function') activeRenameDialog.close();
          else activeRenameDialog.removeAttribute('open');
          loadActive(false);
          if (typeof queueInitialized !== 'undefined' && queueInitialized) loadQueue();
        })
        .catch(function (err) {
          activeRenameError.textContent = err.message;
          status.textContent = t('common.error') + err.message;
        });
    });
  }`;
