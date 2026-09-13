// Dashboard page served by the Worker: inline CSS + vanilla JS, no external
// assets, no build step.
//
// The markup used to live in this single ~4k-line file. It is now split into
// focused modules under ./page/ (styles, body panels, per-language i18n,
// client-script fragments); this file only assembles them. Translations live
// in ./page/i18n/*.ts as the source of truth and are serialized to JS at
// render time.
import { renderBody } from './page/body';
import { renderClientScript } from './page/script';
import { PAGE_STYLES } from './page/styles';

export function renderPage(token: string, role: 'admin' | 'readonly' = 'admin'): string {
  const scriptToken = JSON.stringify(token).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const isAdmin = role === 'admin';
  const adminOnlyAttr = isAdmin ? '' : ' hidden';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Trinity Alliance Tracker</title>
<style>
${PAGE_STYLES}
</style>
</head>
<body>
${renderBody({ isAdmin, adminOnlyAttr })}

${renderClientScript(scriptToken, isAdmin)}
</body>
</html>`;
}
