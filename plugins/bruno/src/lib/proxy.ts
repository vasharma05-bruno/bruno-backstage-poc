/**
 * "Try it out" request routing.
 *
 * Browser-direct `fetch` to an external API host (e.g. echo.usebruno.com) from
 * inside the Backstage portal will usually hit CORS. Per docs/POC-DECISIONS.md
 * D4, we route known hosts through Backstage's proxy-backend instead.
 *
 * TODO(orchestrator): the proxy endpoints below must be configured in
 * app-config.yaml under `proxy.endpoints`, e.g.
 *
 *   proxy:
 *     endpoints:
 *       '/bruno-echo':
 *         target: 'https://echo.usebruno.com'
 *         changeOrigin: true
 *         allowedMethods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS','HEAD']
 *         allowedHeaders: ['Authorization','Content-Type','Accept']
 *
 * Add one entry per host you want proxied and mirror it in PROXY_HOST_MAP.
 */

/**
 * Map of external host -> proxy endpoint path (the key under
 * `proxy.endpoints`). Extend this as more hosts need proxying.
 */
export const PROXY_HOST_MAP: Record<string, string> = {
  'echo.usebruno.com': '/bruno-echo',
  'testbench-sanity.usebruno.com': '/bruno-testbench',
  'www.example.com': '/bruno-example'
};

export interface ResolvedRequestUrl {
  /** Fully-qualified URL to fetch. */
  url: string;
  /** True when routed through the Backstage proxy (CORS-safe). */
  viaProxy: boolean;
}

/**
 * Resolve the URL to actually fetch for "try it out".
 *
 * When the target host is a known proxied host, returns a URL under
 * `${proxyBaseUrl}${endpoint}${pathAndQuery}` (CORS-safe). Otherwise returns
 * the original URL for a direct fetch — which may fail with CORS; the caller
 * surfaces that gracefully in the UI.
 *
 * @param rawUrl - the request URL, already template-resolved.
 * @param proxyBaseUrl - result of `discoveryApi.getBaseUrl('proxy')`.
 */
export function resolveViaProxy(
  rawUrl: string,
  proxyBaseUrl: string
): ResolvedRequestUrl {
  try {
    const u = new URL(rawUrl);
    const endpoint = PROXY_HOST_MAP[u.hostname];
    if (endpoint) {
      const pathAndQuery = `${u.pathname}${u.search}`;
      return {
        url: `${proxyBaseUrl}${endpoint}${pathAndQuery}`,
        viaProxy: true
      };
    }
  } catch {
    // not a parseable absolute URL; fall through to direct
  }
  return { url: rawUrl, viaProxy: false };
}
