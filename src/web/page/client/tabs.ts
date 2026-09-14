// Client-side JS: Tab switching, language selector wiring, initial load.
// String fragment concatenated inside the dashboard IIFE by ../script.ts.
// Shares scope with the other fragments (single IIFE); keep original order.
export const CLIENT_TABS: string = `  // ---- Tab switching ----
  var validTabs = {};
  var evNeedsRefresh = false; // set when display timezone changes
  document.querySelectorAll('nav.tabs button').forEach(function (b) { validTabs[b.dataset.tab] = true; });

  function switchTab(name, skipHash) {
    if (!validTabs[name]) name = 'active';
    document.querySelectorAll('nav.tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.getElementById('panel-active').classList.toggle('hidden', name !== 'active');
    document.getElementById('panel-pick').classList.toggle('hidden', name !== 'pick');
    document.getElementById('panel-board').classList.toggle('hidden', name !== 'board');
    document.getElementById('panel-upload').classList.toggle('hidden', name !== 'upload');
    document.getElementById('panel-queue').classList.toggle('hidden', name !== 'queue');
    const eventsPanel = document.getElementById('panel-events');
    if (eventsPanel) eventsPanel.classList.toggle('hidden', name !== 'events');
    const settingsPanel = document.getElementById('panel-settings');
    if (settingsPanel) settingsPanel.classList.toggle('hidden', name !== 'settings');
    if (name === 'board' && !boardInitialized) {
      boardInitialized = true;
      loadBoardList();
    }
    if (name === 'queue' && !queueInitialized) {
      queueInitialized = true;
      loadQueue();
    }
    if (name === 'upload') {
      ensureUploadExamples();
    }
    if (name === 'events' && !evInitialized) {
      evInitialized = true;
      evInit();
    } else if (name === 'events' && evNeedsRefresh && evCurrentEventId) {
      evNeedsRefresh = false;
      evLoadEvent(evCurrentEventId);
    }
    if (name === 'settings' && !settingsInitialized) {
      settingsInitialized = true;
      settingsInit();
    } else if (name === 'settings' && settingsInitialized && IS_ADMIN) {
      // Re-check the open-now button state on every visit (form untouched, so
      // unsaved edits survive): the event may have been opened elsewhere.
      try { settingsRefreshOpenState(); } catch (e) { /* ignore */ }
    }
    if (!skipHash) {
      try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    }
  }
  document.querySelectorAll('nav.tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
  });
  // Restore tab from URL hash on page load
  var hashTab = (location.hash || '').replace('#', '');
  if (hashTab && validTabs[hashTab]) {
    switchTab(hashTab, true);
  }

  // ---- Language selector ----
  const langSelect = document.getElementById('lang-select');
  if (langSelect) {
    langSelect.value = LANG;
    langSelect.addEventListener('change', function () {
      setLang(langSelect.value);
      // Re-render dynamic panels that may show translated text
      const activeStatus = document.getElementById('active-status');
      if (activeStatus && activeStatus.textContent && activeStatus.textContent.indexOf('Error:') !== 0) {
        loadActive(false);
      }
      if (queueInitialized) loadQueue();
      if (boardInitialized) loadBoardList();
      // Refresh queue log count and missing-members list (re-renders with current data)
      try { renderQueue(); } catch (e) { /* ignore */ }
      try { renderMissingList(); } catch (e) { /* ignore */ }
      // Update pick selected count label
      try { updateSelectedCount(); } catch (e) { /* ignore */ }
    });
  }
  applyI18n();

  // Initial load
  loadActive();`;
