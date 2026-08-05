# Sample Bruno Collections

Sample data for the **Bruno-in-Backstage POC**. These collections are copied and
curated from the [usebruno/bruno](https://github.com/usebruno/bruno)
`packages/bruno-tests/` fixtures.

Every request here targets **public endpoints only** — no local servers, Docker,
Keycloak, OAuth, or secrets are required. You can open and run these in Bruno (or
through the Backstage plugin) with no local setup.

## Collections

### `sandwich-exec/` — 1 request
Demonstrates the "sandwich" script execution order (collection → folder → request
pre-request scripts, then request → folder → collection post-response scripts).
- Requests: 1 (`folder/request.bru`)
- Public endpoint: `https://www.example.com`

### `sequential-exec/` — 1 request
Demonstrates sequential script execution order.
- Requests: 1 (`folder/request.bru`)
- Public endpoint: `https://www.example.com`

### `echo-demo/` — 9 requests
A curated collection showing a realistic API surface (GET/POST, query params,
headers, JSON/text/XML/form bodies, asserts, and test blocks) against Bruno's
public echo/testbench services. Uses a single environment, `environments/Public.bru`.

Requests (in `echo/`, seq 1–9):

| seq | name | method | resolves to |
| --- | --- | --- | --- |
| 1 | ping | GET | `https://testbench-sanity.usebruno.com/ping` |
| 2 | ping with query params | GET | `https://testbench-sanity.usebruno.com/ping?page=1&limit=10&sort=desc` |
| 3 | echo headers | POST | `https://echo.usebruno.com` |
| 4 | echo json | POST | `https://testbench-sanity.usebruno.com/api/echo/json` |
| 5 | echo numbers | POST | `https://echo.usebruno.com` |
| 6 | echo plaintext | POST | `https://testbench-sanity.usebruno.com/api/echo/text` |
| 7 | echo form-url-encoded | POST | `https://echo.usebruno.com` |
| 8 | echo default request headers | POST | `https://echo.usebruno.com` |
| 9 | echo xml raw | POST | `https://testbench-sanity.usebruno.com/api/echo/xml-raw` |

Environment variables (`environments/Public.bru`):
- `host` = `https://testbench-sanity.usebruno.com`
- `echo-host` = `https://echo.usebruno.com`
- `httpfaker` = `https://www.httpfaker.org` (provided for reference; no shipped request uses it)

## Public base URLs used across all collections

- `https://www.example.com`
- `https://testbench-sanity.usebruno.com`
- `https://echo.usebruno.com`

## Notes on curation

Requests that require auth servers, OAuth, digest auth against localhost, file
uploads referencing binary assets, or SSE were intentionally excluded so the demo
is fully self-contained. `seq` values were renumbered to be sequential and each
request's `meta { name }` is unique within its folder.
