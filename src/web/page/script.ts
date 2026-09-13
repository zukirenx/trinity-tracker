// Assembles the dashboard <script> block: token/role constants, the i18n
// table, then the client fragments in dependency order. Fragments share one
// IIFE scope — order matters, keep it identical to the original page.ts.
// Blank-line separators mirror the original layout exactly.
import { CLIENT_ACTIVE } from './client/active';
import { CLIENT_BOARD } from './client/board';
import { CLIENT_CORE } from './client/core';
import { CLIENT_EVENTS } from './client/events';
import { CLIENT_PICK } from './client/pick';
import { CLIENT_QUEUE } from './client/queue';
import { CLIENT_ROSTER } from './client/roster';
import { CLIENT_SETTINGS } from './client/settings';
import { CLIENT_TABS } from './client/tabs';
import { renderTranslationsJs } from './i18n/index';

export function renderClientScript(scriptToken: string, isAdmin: boolean): string {
  return [
    '<script>',
    '(function () {',
    `  const TOKEN = ${scriptToken};`,
    `  const IS_ADMIN = ${JSON.stringify(isAdmin)};`,
    '  const CAN_REGISTER = true;',
    '',
    '  // ---- i18n ----',
    ...renderTranslationsJs().split('\n'),
    '',
    ...CLIENT_CORE.split('\n'),
    '',
    ...CLIENT_ACTIVE.split('\n'),
    '',
    ...CLIENT_PICK.split('\n'),
    '',
    ...CLIENT_BOARD.split('\n'),
    '',
    ...CLIENT_QUEUE.split('\n'),
    '',
    ...CLIENT_EVENTS.split('\n'),
    '',
    ...CLIENT_ROSTER.split('\n'),
    '',
    ...CLIENT_SETTINGS.split('\n'),
    '',
    ...CLIENT_TABS.split('\n'),
    '})();',
    '</script>',
  ].join('\n');
}
