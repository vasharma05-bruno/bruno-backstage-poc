import type {
  Item,
  KeyValue,
  NormalizedCollection,
  Param,
  RequestAuth,
  RequestBody,
  RequestItem
} from '../types';

/**
 * Scenario B — "generate HTML and link out" fallback.
 *
 * Returns a FULLY SELF-CONTAINED HTML document (inline `<style>`, no external
 * scripts, no CDN references) that renders a Bruno collection's docs. It must
 * work entirely offline. Every interpolated value is HTML-escaped.
 *
 * @public
 */
export function generateCollectionHtml(
  collection: NormalizedCollection
): string {
  const requestCount = countRequests(collection.items);
  const sidebar = renderSidebar(collection.items, []);
  const content = renderContent(collection.items, []);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(collection.name)} — Bruno Collection Docs</title>
<style>
${STYLES}
</style>
</head>
<body>
<div class="bruno-layout">
  <aside class="bruno-sidebar">
    <div class="bruno-sidebar-header">
      <div class="bruno-logo">Bruno</div>
      <div class="bruno-collection-name">${esc(collection.name)}</div>
      <div class="bruno-meta">
        ${requestCount} request${requestCount === 1 ? '' : 's'}${
          collection.version ? ` &middot; v${esc(collection.version)}` : ''
        }
      </div>
    </div>
    ${
      collection.environments.length
        ? `<div class="bruno-sidebar-section">
        <div class="bruno-section-label">Environments</div>
        <ul class="bruno-env-list">
          ${collection.environments
            .map((e) => `<li><a href="#env-${slug(e.name)}">${esc(e.name)}</a></li>`)
            .join('\n          ')}
        </ul>
      </div>`
        : ''
    }
    <nav class="bruno-nav">
      ${sidebar || '<div class="bruno-empty">No requests</div>'}
    </nav>
  </aside>
  <main class="bruno-main">
    <header class="bruno-main-header">
      <h1>${esc(collection.name)}</h1>
      <p class="bruno-subtitle">Collection documentation &middot; ${requestCount} request${
        requestCount === 1 ? '' : 's'
      }</p>
    </header>
    ${content || '<p class="bruno-empty">This collection has no requests.</p>'}
    ${renderEnvironments(collection)}
  </main>
</div>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/*  Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

function renderSidebar(items: Item[], trail: string[]): string {
  return items
    .map((item) => {
      if (item.type === 'folder') {
        const nextTrail = [...trail, item.name];
        return `<div class="bruno-nav-folder">
          <div class="bruno-nav-folder-name">${esc(item.name)}</div>
          <div class="bruno-nav-folder-children">
            ${renderSidebar(item.items, nextTrail)}
          </div>
        </div>`;
      }
      const id = requestId([...trail, item.name]);
      return `<a class="bruno-nav-request" href="#${id}">
        <span class="bruno-method bruno-method-${methodClass(item.method)}">${esc(
          item.method
        )}</span>
        <span class="bruno-nav-request-name">${esc(item.name)}</span>
      </a>`;
    })
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Main content                                                               */
/* -------------------------------------------------------------------------- */

function renderContent(items: Item[], trail: string[]): string {
  return items
    .map((item) => {
      if (item.type === 'folder') {
        const nextTrail = [...trail, item.name];
        const heading = [...nextTrail].map(esc).join(' / ');
        return `<section class="bruno-folder">
          <h2 class="bruno-folder-heading">${heading}</h2>
          ${item.docs ? `<div class="bruno-docs">${renderText(item.docs)}</div>` : ''}
          ${renderContent(item.items, nextTrail)}
        </section>`;
      }
      return renderRequest(item, trail);
    })
    .join('\n');
}

function renderRequest(item: RequestItem, trail: string[]): string {
  const id = requestId([...trail, item.name]);
  const sections: string[] = [];

  sections.push(`<div class="bruno-request-line">
    <span class="bruno-method bruno-method-${methodClass(item.method)}">${esc(
      item.method
    )}</span>
    <code class="bruno-url">${esc(item.url)}</code>
  </div>`);

  if (item.docs) {
    sections.push(
      `<div class="bruno-docs">${renderText(item.docs)}</div>`
    );
  }

  const queryParams = item.params.filter((p) => p.type === 'query');
  const pathParams = item.params.filter((p) => p.type === 'path');

  if (pathParams.length) {
    sections.push(renderKvTable('Path Params', pathParams));
  }
  if (queryParams.length) {
    sections.push(renderKvTable('Query Params', queryParams));
  }
  if (item.headers.length) {
    sections.push(renderKvTable('Headers', item.headers));
  }

  const bodyHtml = renderBody(item.body);
  if (bodyHtml) {
    sections.push(bodyHtml);
  }

  const authHtml = renderAuth(item.auth);
  if (authHtml) {
    sections.push(authHtml);
  }

  if (item.assertions && item.assertions.length) {
    sections.push(`<div class="bruno-block">
      <h4>Assertions</h4>
      <table class="bruno-table">
        <thead><tr><th>Expression</th><th>Operator</th><th>Value</th><th>Enabled</th></tr></thead>
        <tbody>
          ${item.assertions
            .map(
              (a) => `<tr class="${a.enabled ? '' : 'bruno-disabled'}">
            <td><code>${esc(a.expr)}</code></td>
            <td><code>${esc(a.op)}</code></td>
            <td><code>${esc(a.value)}</code></td>
            <td>${a.enabled ? 'yes' : 'no'}</td>
          </tr>`
            )
            .join('\n          ')}
        </tbody>
      </table>
    </div>`);
  }

  if (item.script?.req) {
    sections.push(renderCodeBlock('Pre-request Script', item.script.req));
  }
  if (item.script?.res) {
    sections.push(renderCodeBlock('Post-response Script', item.script.res));
  }
  if (item.tests) {
    sections.push(renderCodeBlock('Tests', item.tests));
  }

  return `<article class="bruno-request" id="${id}">
    <h3 class="bruno-request-title">${esc(item.name)}</h3>
    ${sections.join('\n    ')}
  </article>`;
}

function renderKvTable(title: string, rows: Array<KeyValue | Param>): string {
  return `<div class="bruno-block">
    <h4>${esc(title)}</h4>
    <table class="bruno-table">
      <thead><tr><th>Name</th><th>Value</th><th>Enabled</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr class="${r.enabled ? '' : 'bruno-disabled'}">
          <td><code>${esc(r.name)}</code></td>
          <td><code>${esc(r.value)}</code></td>
          <td>${r.enabled ? 'yes' : 'no'}</td>
        </tr>`
          )
          .join('\n        ')}
      </tbody>
    </table>
  </div>`;
}

function renderBody(body?: RequestBody): string {
  if (!body || body.mode === 'none') {
    return '';
  }
  if (body.form) {
    return `<div class="bruno-block">
      <h4>Body <span class="bruno-tag">${esc(body.mode)}</span></h4>
      ${renderKvTable('', body.form)}
    </div>`;
  }
  if (body.raw !== undefined && body.raw !== '') {
    return `<div class="bruno-block">
      <h4>Body <span class="bruno-tag">${esc(body.mode)}</span></h4>
      <pre class="bruno-code">${esc(body.raw)}</pre>
    </div>`;
  }
  return `<div class="bruno-block">
    <h4>Body <span class="bruno-tag">${esc(body.mode)}</span></h4>
  </div>`;
}

function renderAuth(auth?: RequestAuth): string {
  if (!auth || auth.mode === 'none') {
    return '';
  }
  const summary = summarizeAuth(auth);
  return `<div class="bruno-block">
    <h4>Auth <span class="bruno-tag">${esc(auth.mode)}</span></h4>
    ${
      summary
        ? `<table class="bruno-table"><tbody>${summary}</tbody></table>`
        : ''
    }
  </div>`;
}

/**
 * Renders a small summary of auth fields. Secret-looking values (password /
 * token / secret) are masked so the generated HTML never surfaces raw secrets.
 */
function summarizeAuth(auth: RequestAuth): string {
  const rows: string[] = [];
  for (const [key, value] of Object.entries(auth)) {
    if (key === 'mode') {
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      continue;
    }
    const strValue = String(value);
    const masked = isSecretKey(key) ? maskSecret(strValue) : strValue;
    rows.push(
      `<tr><td><code>${esc(key)}</code></td><td><code>${esc(
        masked
      )}</code></td></tr>`
    );
  }
  return rows.join('\n');
}

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes('password')
    || k.includes('token')
    || k.includes('secret')
    || k === 'value'
  );
}

function maskSecret(value: string): string {
  if (!value) {
    return '';
  }
  // Preserve template placeholders like {{token}} for readability.
  if (/^\{\{.*\}\}$/.test(value.trim())) {
    return value;
  }
  return '••••••••';
}

function renderCodeBlock(title: string, code: string): string {
  return `<div class="bruno-block">
    <h4>${esc(title)}</h4>
    <pre class="bruno-code">${esc(code)}</pre>
  </div>`;
}

function renderEnvironments(collection: NormalizedCollection): string {
  if (!collection.environments.length) {
    return '';
  }
  return `<section class="bruno-folder">
    <h2 class="bruno-folder-heading">Environments</h2>
    ${collection.environments
      .map(
        (env) => `<article class="bruno-request" id="env-${slug(env.name)}">
      <h3 class="bruno-request-title">${esc(env.name)}</h3>
      ${
        env.variables.length
          ? renderKvTable('Variables', env.variables)
          : '<p class="bruno-empty">No variables</p>'
      }
    </article>`
      )
      .join('\n    ')}
  </section>`;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function countRequests(items: Item[]): number {
  let count = 0;
  for (const item of items) {
    if (item.type === 'folder') {
      count += countRequests(item.items);
    } else {
      count += 1;
    }
  }
  return count;
}

/** Renders freeform docs text. Escaped, with newlines preserved. */
function renderText(text: string): string {
  return `<pre class="bruno-doc-text">${esc(text)}</pre>`;
}

function requestId(trail: string[]): string {
  return `req-${trail.map(slug).join('-')}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function methodClass(method: string): string {
  const m = method.toLowerCase();
  const known = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];
  return known.includes(m) ? m : 'other';
}

/** HTML-escape a value for safe interpolation into markup. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  --bruno-bg: #ffffff;
  --bruno-fg: #1b1f23;
  --bruno-muted: #6a737d;
  --bruno-border: #e1e4e8;
  --bruno-sidebar-bg: #fafbfc;
  --bruno-code-bg: #f6f8fa;
  --bruno-accent: #f2760c;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--bruno-fg);
  background: var(--bruno-bg);
  line-height: 1.5;
}
.bruno-layout { display: flex; min-height: 100vh; }
.bruno-sidebar {
  width: 300px;
  flex: 0 0 300px;
  border-right: 1px solid var(--bruno-border);
  background: var(--bruno-sidebar-bg);
  overflow-y: auto;
  position: sticky;
  top: 0;
  height: 100vh;
  padding: 16px;
}
.bruno-sidebar-header { margin-bottom: 20px; }
.bruno-logo {
  font-weight: 700;
  color: var(--bruno-accent);
  font-size: 18px;
  letter-spacing: 0.5px;
}
.bruno-collection-name { font-weight: 600; font-size: 15px; margin-top: 6px; }
.bruno-meta { color: var(--bruno-muted); font-size: 12px; margin-top: 2px; }
.bruno-sidebar-section { margin-bottom: 16px; }
.bruno-section-label {
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.6px;
  color: var(--bruno-muted);
  margin-bottom: 6px;
}
.bruno-env-list { list-style: none; padding: 0; margin: 0; }
.bruno-env-list a {
  display: block;
  padding: 4px 6px;
  color: var(--bruno-fg);
  text-decoration: none;
  border-radius: 4px;
  font-size: 13px;
}
.bruno-env-list a:hover { background: #eef1f4; }
.bruno-nav-folder { margin: 4px 0; }
.bruno-nav-folder-name {
  font-weight: 600;
  font-size: 13px;
  padding: 4px 6px;
  color: var(--bruno-fg);
}
.bruno-nav-folder-children {
  border-left: 1px solid var(--bruno-border);
  margin-left: 8px;
  padding-left: 6px;
}
.bruno-nav-request {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  text-decoration: none;
  color: var(--bruno-fg);
  border-radius: 4px;
  font-size: 13px;
}
.bruno-nav-request:hover { background: #eef1f4; }
.bruno-nav-request-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bruno-main { flex: 1 1 auto; padding: 32px 40px; max-width: 900px; overflow-x: hidden; }
.bruno-main-header { margin-bottom: 28px; border-bottom: 1px solid var(--bruno-border); padding-bottom: 16px; }
.bruno-main-header h1 { margin: 0; font-size: 26px; }
.bruno-subtitle { color: var(--bruno-muted); margin: 6px 0 0; font-size: 14px; }
.bruno-folder { margin-bottom: 36px; }
.bruno-folder-heading {
  font-size: 18px;
  border-bottom: 1px solid var(--bruno-border);
  padding-bottom: 8px;
  color: var(--bruno-muted);
}
.bruno-request {
  border: 1px solid var(--bruno-border);
  border-radius: 8px;
  padding: 18px 20px;
  margin-bottom: 24px;
  scroll-margin-top: 16px;
}
.bruno-request-title { margin: 0 0 12px; font-size: 16px; }
.bruno-request-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.bruno-url {
  background: var(--bruno-code-bg);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  word-break: break-all;
}
.bruno-method {
  font-weight: 700;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  color: #fff;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.bruno-method-get { background: #10a35a; }
.bruno-method-post { background: #2f6fed; }
.bruno-method-put { background: #d98a00; }
.bruno-method-patch { background: #8250df; }
.bruno-method-delete { background: #d1242f; }
.bruno-method-head, .bruno-method-options, .bruno-method-other { background: #6a737d; }
.bruno-block { margin: 14px 0; }
.bruno-block h4 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--bruno-muted); }
.bruno-tag {
  display: inline-block;
  background: var(--bruno-code-bg);
  color: var(--bruno-fg);
  border: 1px solid var(--bruno-border);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  text-transform: none;
  letter-spacing: 0;
  margin-left: 6px;
}
.bruno-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.bruno-table th, .bruno-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--bruno-border);
  vertical-align: top;
}
.bruno-table th { color: var(--bruno-muted); font-weight: 600; font-size: 12px; }
.bruno-table code { word-break: break-all; }
.bruno-disabled { opacity: 0.5; text-decoration: line-through; }
.bruno-code, .bruno-doc-text {
  background: var(--bruno-code-bg);
  border: 1px solid var(--bruno-border);
  border-radius: 6px;
  padding: 12px 14px;
  font-size: 12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.bruno-docs { margin: 8px 0 14px; }
.bruno-doc-text {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: transparent;
  border: none;
  padding: 0;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--bruno-code-bg);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12.5px;
}
.bruno-empty { color: var(--bruno-muted); font-style: italic; font-size: 13px; }
`;
