# bruno-catalog — Bruno collections → Backstage API entities

Generates [`examples/bruno-collections.yaml`](../../examples/bruno-collections.yaml):
five production Bruno collections from
[github.com/bruno-collections](https://github.com/bruno-collections), each a
Backstage `kind: API` entity whose `spec.definition` is an **OpenAPI 3.0.3
document generated from the collection itself**.

```bash
yarn bruno:catalog            # regenerate examples/bruno-collections.yaml
yarn bruno:catalog:check      # non-zero exit if the file is stale
yarn bruno:catalog:validate   # validate entities + OpenAPI definitions
```

The file is registered in `app-config.yaml` under `catalog.locations`, so the
entities appear in the catalog on backend start.

## The important caveat: there is no `brunoToOpenApi`

`@usebruno/converters@0.22.0` (the latest published version) converts **into**
Bruno and **sideways**, never into OpenAPI:

| Export | Direction |
| --- | --- |
| `openApiToBruno`, `postmanToBruno`, `insomniaToBruno`, `wsdlToBruno`, `openCollectionToBruno` | → Bruno |
| `brunoToPostman`, `brunoToOpenCollection` | Bruno → other format |
| `postmanToBrunoEnvironment`, `postmanTranslation` | helpers |

So the converter package cannot produce the OpenAPI document on its own. It is
used for the part it *does* own — normalizing a Bruno collection into the
canonical OpenCollection `1.0.0` model via `brunoToOpenCollection` — and
[`openCollectionToOpenApi.mjs`](./openCollectionToOpenApi.mjs) maps that
canonical model to OpenAPI. Building on OpenCollection rather than raw
`.bru`/`.yml` means both on-disk formats are handled by the converter, not here.

## Pipeline

```
git clone --depth 1                    cached under <tmpdir>/bruno-catalog-cache
  ↓
readBrunoCollection()                  @usebruno/lang (.bru)
                                       @usebruno/filestore (.yml / OpenCollection)
  ↓  Bruno in-memory collection
brunoToOpenCollection()                @usebruno/converters
  ↓  OpenCollection 1.0.0
attachBrunoSignals()                   re-attaches assert / tests / script
  ↓
openCollectionToOpenApi()              OpenAPI 3.0.3
  ↓
ApiEntity { spec.definition: <yaml> }
```

`readBrunoCollection` deliberately mirrors
`plugins/bruno-backend/src/service/collectionService.ts` — same parsers, same
format detection, same ordering — so a collection that renders in the Bruno card
and one that converts here agree on structure.

### Why `attachBrunoSignals` exists

`brunoToOpenCollection` drops the `assert` block, the `tests` block and the
pre/post-request `script`s. Those are precisely where a Bruno collection records
what an endpoint returns (`res.status: eq 200`,
`expect(res.status).to.eql(201)`), and for most collections they are the *only*
response evidence available. Without re-attaching them, nearly every operation
would be documented as a bare `default` response. The module walks the Bruno
model and the OpenCollection output in lockstep and copies those blocks back.

## Mapping rules

| Bruno | OpenAPI 3.0.3 |
| --- | --- |
| `{{baseUrl}}/orders/:id` | server `{baseUrl}` (default from the collection's environment) + path `/orders/{id}` |
| `params[type=path]` | `in: path`, `required: true`, description/example preserved |
| `params[type=query]` + inline `?a=b` | `in: query`, example coerced to the inferred type |
| `headers` | `in: header` (`Authorization`, `Content-Type`, `Host`, `Cookie` dropped — OpenAPI models those elsewhere) |
| `body` (json/text/xml/sparql/form/multipart/file) | `requestBody`, schema **inferred from the recorded payload** |
| graphql request | `POST` with a `{ query, variables }` body |
| `examples[].response` | real `responses`: status code, media type from the recorded `Content-Type`, schema + example |
| asserted / tested `res.status` | additional response codes |
| `auth` | `components.securitySchemes` + per-operation `security` (basic, bearer, digest, apikey, oauth2, awsv4, wsse, ntlm) |
| `info.tags`, else folder path | `tags` — Swagger UI grouping |
| gRPC / WebSocket requests | skipped, reported as a warning |

Choices worth knowing:

- **Inferred object schemas carry no `required` list.** An example payload shows
  what a caller *sent*; that is not evidence about what the API demands.
- **Requests sharing a method + path are folded together**, not dropped — the
  second request's responses and body example are merged into the first, and the
  fold is reported. This is common and correct: seven GitHub "Search X Repos"
  requests are all `GET /search/repositories` with a different `q`.
- **An unresolved `{{var}}` server says so** in its description rather than
  quietly presenting an invented default as the real base URL.
- **`default` response means the collection recorded nothing** — no example, no
  status assertion. That is stated in the response description rather than
  papered over with a fabricated `200`.
- Anything OpenAPI cannot express (`seq`, script presence, raw assertions,
  unparseable bodies, source URL) is preserved under `x-bruno-*` extensions.

## Annotations on the emitted entities

`bruno.dev/source-url`, `bruno.dev/collection-format` and
`backstage.io/source-location` only. `bruno.dev/collection-id` and
`bruno.dev/collection-path` are deliberately **absent**: those belong to
`BrunoEntityProvider` (config-materialized collections) and
`BrunoLinkProcessor` (runtime connections). Setting `collection-path` here would
make the processor skip the entity — see the early return in
`plugins/bruno-backend/src/processor/BrunoLinkProcessor.ts` — breaking the Bruno
card's Connect flow. Because the Bruno cards attach to *any* API entity
(`isApiEntity` in `plugins/bruno/src/extensions.tsx`), these entities get both
the rendered OpenAPI definition **and** a working Connect prompt.

## Adding or changing a source

Edit [`sources.mjs`](./sources.mjs) and rerun `yarn bruno:catalog`. `subpath`
points at the collection root (the directory holding `bruno.json` or
`opencollection.yml`), which in workspace repos is under `collections/<name>`.
`excludeFolders` skips folders by name — used for the webinar collection, whose
`Solution/` folders duplicate every request and would collide on every path.

## Validation

`yarn bruno:catalog:validate` checks two things:

1. **Catalog side** — every document runs through the catalog backend's own
   validators (`@backstage/catalog-model` entity policies + per-kind schema
   validators), so a passing file is a file the catalog will ingest.
2. **OpenAPI side** — every `spec.definition` is validated against the official
   OpenAPI 3.0 JSON Schema (`@apidevtools/openapi-schemas`), plus the structural
   rules that schema cannot express: `{param}` must have a matching required
   path parameter and vice versa, every `security` requirement must name a
   declared scheme, every server variable must be declared, and every operation
   must have at least one response.
