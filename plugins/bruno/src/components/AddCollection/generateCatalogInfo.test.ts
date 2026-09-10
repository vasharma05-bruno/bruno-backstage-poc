import {
  buildBrunoEntity,
  sanitizeEntityName,
  toCatalogInfoYaml,
  validateEntityTitle
} from './generateCatalogInfo';
import type { BrunoEntityInput } from './generateCatalogInfo';

/** The form as the dialog hands it over, with only the field under test moved. */
function input(overrides?: Partial<BrunoEntityInput>): BrunoEntityInput {
  return {
    name: 'payments',
    url: 'https://github.com/acme/apis/tree/main/collections/payments',
    partOf: [],
    ...overrides
  };
}

describe('buildBrunoEntity', () => {
  it('writes the title the form supplied', () => {
    expect(
      buildBrunoEntity(input({ title: 'Payments API (v2)' })).metadata.title
    ).toBe('Payments API (v2)');
  });

  it('trims a title before writing it', () => {
    expect(
      buildBrunoEntity(input({ title: '  Payments API  ' })).metadata.title
    ).toBe('Payments API');
  });

  /**
   * The opt-out, and the reason `title` is optional rather than defaulted: with
   * no key on the descriptor, `BrunoKindProcessor` resolves the field as
   * `keep(authored) ?? manifest.name` and goes on deriving it from the
   * collection manifest. A `title: ''` would be an authored value the catalog
   * then ignores, which is the one outcome nobody can explain from the file.
   */
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '   ']
  ])('omits the key entirely for a %s title', (_case, title) => {
    const entity = buildBrunoEntity(input({ title }));
    expect(entity.metadata).not.toHaveProperty('title');
  });

  it('leaves description and version to the manifest either way', () => {
    const entity = buildBrunoEntity(input({ title: 'Payments API' }));
    expect(entity.metadata).not.toHaveProperty('description');
    expect(entity.metadata).not.toHaveProperty('version');
  });
});

describe('toCatalogInfoYaml', () => {
  it('serialises the title into metadata, under the name', () => {
    const yaml = toCatalogInfoYaml(
      buildBrunoEntity(input({ title: 'Payments API' }))
    );
    expect(yaml).toContain('  name: payments\n  title: Payments API\n');
  });

  /** The reviewer of the pull request has to be told which file now owns the
   *  display name, and that answer differs by branch. */
  it('tells the reader the title wins over the manifest', () => {
    const yaml = toCatalogInfoYaml(
      buildBrunoEntity(input({ title: 'Payments API' }))
    );
    expect(yaml).toContain('# `metadata.title` below is what Backstage');
  });

  it('lists the title among the omitted fields when there is none', () => {
    const yaml = toCatalogInfoYaml(buildBrunoEntity(input()));
    expect(yaml).toContain(
      '# `metadata.title`, `metadata.description` and `metadata.version` are'
    );
    expect(yaml).not.toContain('title:');
  });

  /** A title is free prose, so it reaches YAML that has to quote it. The
   *  descriptor is committed to a repository, so it has to be valid. */
  it('quotes a title that would otherwise break the document', () => {
    const yaml = toCatalogInfoYaml(
      buildBrunoEntity(input({ title: 'Payments: the API' }))
    );
    expect(yaml).toContain('title: "Payments: the API"');
  });
});

describe('validateEntityTitle', () => {
  it('accepts an empty title, which is the opt-out', () => {
    expect(validateEntityTitle('')).toBeUndefined();
  });

  it('accepts the punctuation an entity name cannot hold', () => {
    expect(validateEntityTitle('Payments API (v2) — internal')).toBeUndefined();
  });

  it('rejects a title past the length a fetched one is clamped to', () => {
    expect(validateEntityTitle('x'.repeat(255))).toBeUndefined();
    expect(validateEntityTitle('x'.repeat(256))).toBe(
      'Titles are at most 255 characters.'
    );
  });
});

/**
 * The pairing the dialog seeds from one manifest name: the title keeps it
 * verbatim and the name is slugged to fit the catalog's grammar. Asserted
 * together because the value of having both fields is exactly that they differ.
 */
describe('a manifest name seeding both fields', () => {
  it('survives verbatim as the title and slugged as the name', () => {
    const manifestName = 'My Collection (v2)';
    const entity = buildBrunoEntity(
      input({ name: sanitizeEntityName(manifestName), title: manifestName })
    );
    expect(entity.metadata.name).toBe('my-collection-v2');
    expect(entity.metadata.title).toBe('My Collection (v2)');
  });
});
