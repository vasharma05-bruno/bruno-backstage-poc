/**
 * Ambient module declaration for `@usebruno/lang`.
 *
 * The published package (^0.38.0) ships plain JavaScript (`src/index.js`) with
 * no bundled `.d.ts`. It exposes the v2 parsers with a `V2` suffix; the three
 * this plugin uses are declared below. Their return shapes are documented in
 * docs/POC-DECISIONS.md §3 and normalized defensively in collectionService.ts,
 * so `any` here is intentional.
 */
declare module '@usebruno/lang' {
  /** Parse a request `.bru` file (v2 grammar) into a JSON object. */
  export function bruToJsonV2(input: string): any;
  /** Parse an `environments/*.bru` file (v2) into `{ variables: [...] }`. */
  export function bruToEnvJsonV2(input: string): any;
  /** Parse a `collection.bru` / `folder.bru` file into a JSON object. */
  export function collectionBruToJson(input: string): any;
}
