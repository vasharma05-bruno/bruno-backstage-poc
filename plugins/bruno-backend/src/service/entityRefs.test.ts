import { normaliseApiRef, normaliseCollectionRef } from './entityRefs';

describe('normaliseApiRef', () => {
  it('expands the kind and namespace defaults', () => {
    expect(normaliseApiRef('github-rest-api')).toBe(
      'api:default/github-rest-api'
    );
    expect(normaliseApiRef('api:github-rest-api')).toBe(
      'api:default/github-rest-api'
    );
    expect(normaliseApiRef('api:default/github-rest-api')).toBe(
      'api:default/github-rest-api'
    );
  });

  it('lower-cases, so two spellings key one link', () => {
    // The reason both routes normalise before touching the table: an entity ref
    // is lower-cased when it is stringified, so `API:Default/Payments` and
    // `api:default/payments` are one entity and must be one row.
    expect(normaliseApiRef('API:Default/Payments')).toBe(
      'api:default/payments'
    );
  });

  it('keeps a namespace that is not the default', () => {
    expect(normaliseApiRef('api:payments/orders')).toBe(
      'api:payments/orders'
    );
  });

  it('throws on a ref the catalog cannot parse', () => {
    expect(() => normaliseApiRef('')).toThrow('must not be empty');
    expect(() => normaliseApiRef('api:default/')).toThrow('was not on the form');
    expect(() => normaliseApiRef('/orders')).toThrow('was not on the form');
  });
});

describe('normaliseCollectionRef', () => {
  it('defaults the kind to Bruno rather than to API', () => {
    expect(normaliseCollectionRef('payments')).toBe('bruno:default/payments');
  });

  it('leaves an explicit kind alone, so the routes can reject it themselves', () => {
    // Not this function's job to refuse an API ref: `POST /links` reads the
    // entity and says "that is an API entity, not a Bruno collection", which is
    // a far better message than a parse failure.
    expect(normaliseCollectionRef('api:default/payments')).toBe(
      'api:default/payments'
    );
  });
});
