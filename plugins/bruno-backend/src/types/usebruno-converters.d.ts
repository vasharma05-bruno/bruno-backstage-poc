/**
 * Ambient module declaration for `@usebruno/converters` (^0.22.0).
 * The published package ships `dist/cjs/index.js` with NO top-level `.d.ts`
 * and its internal `.d.ts` references `@usebruno/schema-types`, a devDependency
 * that is not installed here. We call only `brunoToOpenCollection`; its input is
 * adapted from our NormalizedCollection (see openCollectionExport.ts), so `any`
 * on the boundary is intentional and safe.
 */
declare module '@usebruno/converters' {
  export function brunoToOpenCollection(collection: any): any;
}
