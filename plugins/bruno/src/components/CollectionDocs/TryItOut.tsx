import { useState } from 'react';
import Button from '@material-ui/core/Button';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import Chip from '@material-ui/core/Chip';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import { CodeSnippet, Progress } from '@backstage/core-components';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import type { Environment, RequestItem } from '../../api/types';
import { buildVarMap, prepareRequest } from '../../lib/template';
import { resolveViaProxy } from '../../lib/proxy';
import { statusColor, badgeTextColor } from '../MethodBadge';

interface TryResult {
  status: number;
  statusText: string;
  viaProxy: boolean;
  headers: Record<string, string>;
  body: string;
}

/**
 * "Try it out" control. Resolves `{{var}}` templates from the collection's
 * first environment, routes the request through the Backstage proxy when the
 * target host is known (CORS-safe), otherwise falls back to a direct fetch and
 * surfaces any CORS/network error gracefully.
 */
export function TryItOut(props: {
  item: RequestItem;
  environments: Environment[];
}) {
  const { item, environments } = props;
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TryResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  const send = async () => {
    setLoading(true);
    setError(undefined);
    setResult(undefined);
    try {
      const vars = buildVarMap(environments);
      const prepared = prepareRequest(item, vars);

      const proxyBase = await discoveryApi.getBaseUrl('proxy');
      const resolved = resolveViaProxy(prepared.url, proxyBase);

      const res = await fetchApi.fetch(resolved.url, {
        method: prepared.method,
        headers: prepared.headers,
        body:
          prepared.method === 'GET' || prepared.method === 'HEAD'
            ? undefined
            : prepared.body
      });

      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const text = await res.text();

      setResult({
        status: res.status,
        statusText: res.statusText,
        viaProxy: resolved.viaProxy,
        headers,
        body: prettyMaybeJson(text)
      });
    } catch (e) {
      // Direct fetch to a non-proxied host most commonly fails here with a
      // CORS / network TypeError. Surface it rather than crashing.
      setError(
        `${e instanceof Error ? e.message : String(e)} — the target host may `
        + `not be proxied. Add it to proxy.endpoints + PROXY_HOST_MAP to avoid CORS.`
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box>
      <Button
        variant="outlined"
        color="primary"
        size="small"
        startIcon={<PlayArrowIcon />}
        onClick={send}
        disabled={loading}
      >
        Try it out
      </Button>
      {loading && <Progress />}
      {error && (
        <Box mt={1}>
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        </Box>
      )}
      {result && (
        <Box mt={2}>
          <Box display="flex" alignItems="center" style={{ gap: 8 }}>
            <Chip
              size="small"
              label={`${result.status} ${result.statusText}`}
              style={{
                backgroundColor: statusColor(result.status),
                color: badgeTextColor,
                fontWeight: 700
              }}
            />
            <Chip
              size="small"
              variant="outlined"
              label={result.viaProxy ? 'via proxy' : 'direct fetch'}
            />
          </Box>
          <Box mt={1}>
            <Typography variant="caption" color="textSecondary">
              Response headers
            </Typography>
            <CodeSnippet
              language="text"
              text={Object.entries(result.headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')}
            />
          </Box>
          <Box mt={1}>
            <Typography variant="caption" color="textSecondary">
              Response body
            </Typography>
            <CodeSnippet language="json" text={result.body} showCopyCodeButton />
          </Box>
        </Box>
      )}
    </Box>
  );
}

function prettyMaybeJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
