/** CDN that hosts the OpenCollection docs renderer bundle (POC: staging). */
const CDN = 'https://staging.cdn.usebruno.com/api-docs';

/** HTML-escape a value for safe interpolation into markup / attributes. */
function escapeHtml(s: string): string {
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
 * This is served from the backend (`GET /collections/:id/docs`) and embedded by
 * the frontend via an iframe `src` (NOT `srcdoc`). Serving it from a real
 * backend origin — rather than an `about:srcdoc` document — is what makes the
 * bundle's `sessionStorage` access and its `HashRouter`-based routing work:
 * both need a real URL/origin, which `srcdoc` does not provide.
 *
 * The YAML is injected as a JSON string literal with any `</script` sequence
 * neutralized (the HTML tokenizer ends a script element on `</script` followed
 * by whitespace, `/`, or `>`, not just `</script>`); the capture group
 * preserves the original casing of the tag.
 *
 * @public
 */
export function generateOcDocsHtml(
  yaml: string,
  title: string,
  theme: 'light' | 'dark'
): string {
  const data = JSON.stringify(yaml).replace(/<(\/script)/gi, '<\\$1');
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
