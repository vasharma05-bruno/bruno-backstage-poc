/** CDN that hosts the OpenCollection docs renderer bundle (POC: staging). */
const CDN = 'https://staging.cdn.usebruno.com/api-docs';

/**
 * HTML-escape a value for safe interpolation into markup or an attribute.
 *
 * Shared with `router.ts`, which builds the framable docs error page: both
 * interpolate a caller-influenced string into a document served as `text/html`,
 * so they must agree on what gets escaped. `"` is included because attribute
 * interpolation is one of the two call sites, and escaping it in a text node
 * costs nothing.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds a self-hosting OpenCollection docs page: a full HTML document that
 * loads the OpenCollection renderer bundle from the CDN and boots it against
 * the collection's OpenCollection YAML.
 *
 * This is served from the backend (`GET /entities/:namespace/:name/docs`) and
 * embedded by the frontend via an iframe `src` (NOT `srcdoc`). Serving it from
 * a real backend origin — rather than an `about:srcdoc` document — is what
 * makes the bundle's `sessionStorage` access and its `HashRouter`-based routing
 * work: both need a real URL/origin, which `srcdoc` does not provide.
 *
 * The YAML is injected as a JSON string literal with EVERY `<` escaped, not
 * just the ones that begin a `</script` sequence. Blocking the end tag alone is
 * not enough: the script-data tokenizer has a double-escape state, and a
 * payload carrying `<!--` followed by `<script` drives it there, after which
 * this document's own `</script>` returns it to "script data escaped" instead
 * of closing the element — the rest of the page is swallowed as script source
 * and the renderer never boots. A collection's YAML is whatever a `.bru` or
 * `opencollection.yaml` file in an ingested repository says, so that is a
 * denial of rendering anyone who can land a file can trigger.
 *
 * A `\u003c` escape inside a double-quoted JS string literal parses back
 * to `<`, so the YAML the renderer receives is byte-identical to the YAML
 * passed in. The two JS line terminators go the same way: they are not valid
 * inside a JSON string literal's source but ARE legal raw in JSON output, and
 * unescaped they would end the statement.
 *
 * @public
 */
export function generateOcDocsHtml(
  yaml: string,
  title: string,
  theme: 'light' | 'dark'
): string {
  const data = JSON.stringify(yaml)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
    `<title>${escapeHtml(title)} - API Documentation</title>`,
    '<style>html,body{margin:0;padding:0;height:100%}#opencollection-container{width:100vw;height:100vh}</style>',
    `<link rel="stylesheet" href="${CDN}/api-docs.css"/>`,
    `<script src="${CDN}/api-docs.js"></script>`,
    '</head><body><div id="opencollection-container"></div>',
    '<script>',
    `const collectionData = ${data};`,
    'new window.OpenCollection({',
    'target: document.getElementById(\'opencollection-container\'),',
    'opencollection: collectionData,',
    `theme: '${theme}' });`,
    '</script></body></html>'
  ].join('');
}
