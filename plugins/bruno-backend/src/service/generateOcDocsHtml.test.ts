import { escapeHtml, generateOcDocsHtml } from './generateOcDocsHtml';

/** The inline boot script's body: everything between the LAST script opener and
 *  the closer that follows it. The CDN tag above it is self-closed and carries
 *  no body, so the last opener is the boot script's. */
function bootScript(html: string): string {
  const open = html.lastIndexOf('<script>') + '<script>'.length;
  const close = html.indexOf('</script>', open);
  expect(close).toBeGreaterThan(open);
  return html.slice(open, close);
}

/** The JS string literal the boot script assigns, parsed back to its value.
 *  The escapes this module emits are all legal JSON escapes, so the literal
 *  the page carries is still parseable as JSON — which is exactly why the
 *  escaping is invisible to the renderer. */
function embeddedYaml(html: string): unknown {
  const body = bootScript(html);
  const prefix = 'const collectionData = ';
  const suffix = ';new window.OpenCollection({';
  const start = body.indexOf(prefix) + prefix.length;
  const end = body.indexOf(suffix);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(body.slice(start, end));
}

describe('generateOcDocsHtml', () => {
  it('does not let a collection break out of the boot script', () => {
    // The payload that defeats an end-tag-only filter: an HTML comment opener
    // followed by a script opener puts the tokenizer into "script data double
    // escaped", where this page's own closer merely returns it to "script data
    // escaped" instead of ending the element. The rest of the document is then
    // swallowed as script source and the renderer never boots. Any `.bru` or
    // `opencollection.yaml` file in an ingested repository can carry it.
    const yaml = 'name: <!--<script>alert(1)</script>-->\n';
    const html = generateOcDocsHtml(yaml, 'Payments', 'light');

    // No `<` survives in the script body at all, so there is no sequence the
    // tokenizer can be driven with — end tag, comment opener or otherwise.
    expect(bootScript(html)).not.toContain('<');
    expect(html.endsWith('</script></body></html>')).toBe(true);
  });

  it('leaves the YAML the renderer receives byte-identical', () => {
    // Escaping `<` as `<` is a no-op for the parsed value, so it is
    // invisible to the renderer. If it were not, every collection documenting
    // an XML or HTML payload would render wrong.
    const yaml
      = 'name: <!--<script>alert(1)</script>-->\nbody: "a < b && c > d"\n';
    expect(embeddedYaml(generateOcDocsHtml(yaml, 'Payments', 'light'))).toBe(
      yaml
    );
  });

  it('escapes the two JS line terminators, which JSON leaves raw', () => {
    // U+2028 and U+2029 are valid unescaped in JSON output but end a statement
    // in a JS string literal, so the same pass has to escape them.
    const yaml = `name: a${String.fromCharCode(0x2028)}b${
      String.fromCharCode(0x2029)}c\n`;
    const html = generateOcDocsHtml(yaml, 'Payments', 'light');
    expect(bootScript(html)).not.toMatch(
      new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`)
    );
    expect(embeddedYaml(html)).toBe(yaml);
  });

  it('escapes the entity title into the document title', () => {
    const html = generateOcDocsHtml('name: x\n', '<img src=x>', 'dark');
    expect(html).toContain(
      '<title>&lt;img src=x&gt; - API Documentation</title>'
    );
    expect(html).toContain('theme: \'dark\'');
  });
});

describe('escapeHtml', () => {
  it('escapes the four characters markup and attributes disagree on', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'
    );
  });
});
