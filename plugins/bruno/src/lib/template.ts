import type { Environment, RequestItem } from '../api/types';

/**
 * Build a `{{var}} -> value` lookup from the collection's first (enabled)
 * environment. Per the POC spec we resolve against the FIRST environment.
 */
export function buildVarMap(
  environments: Environment[] | undefined
): Record<string, string> {
  const env = environments?.[0];
  const map: Record<string, string> = {};
  if (!env) {
    return map;
  }
  for (const v of env.variables) {
    if (v.enabled !== false) {
      map[v.name] = v.value;
    }
  }
  return map;
}

/**
 * Replace `{{var}}` templates in a string using the provided var map.
 * Unknown variables are left untouched.
 */
export function resolveTemplate(
  input: string,
  vars: Record<string, string>
): string {
  return input.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (whole, name: string) => {
    return Object.prototype.hasOwnProperty.call(vars, name)
      ? vars[name]
      : whole;
  });
}

export interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Turn a {@link RequestItem} + var map into a concrete fetch spec:
 * template-resolves URL/headers/body, applies enabled query params, and
 * serializes a JSON/text/xml body.
 */
export function prepareRequest(
  item: RequestItem,
  vars: Record<string, string>
): PreparedRequest {
  const url = resolveTemplate(item.url, vars);

  // Apply enabled query params on top of whatever is already in the URL.
  let finalUrl = url;
  const query = item.params
    .filter((p) => p.type === 'query' && p.enabled !== false)
    .map(
      (p) =>
        `${encodeURIComponent(resolveTemplate(p.name, vars))}=${encodeURIComponent(
          resolveTemplate(p.value, vars)
        )}`
    );
  if (query.length) {
    finalUrl += (url.includes('?') ? '&' : '?') + query.join('&');
  }

  const headers: Record<string, string> = {};
  for (const h of item.headers) {
    if (h.enabled !== false) {
      headers[resolveTemplate(h.name, vars)] = resolveTemplate(h.value, vars);
    }
  }

  let body: string | undefined;
  const mode = item.body?.mode;
  if (mode === 'json' || mode === 'text' || mode === 'xml') {
    body = item.body?.raw
      ? resolveTemplate(item.body.raw, vars)
      : undefined;
    if (mode === 'json' && body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  } else if (mode === 'formUrlEncoded' && item.body?.form) {
    body = item.body.form
      .filter((f) => f.enabled !== false)
      .map(
        (f) =>
          `${encodeURIComponent(resolveTemplate(f.name, vars))}=${encodeURIComponent(
            resolveTemplate(f.value, vars)
          )}`
      )
      .join('&');
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  return { method: item.method || 'GET', url: finalUrl, headers, body };
}
