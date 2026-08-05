import { useEffect, useState } from 'react';
import { InfoCard, MarkdownContent } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { brunoApiRef } from '../../api/BrunoApi';
import type { CollectionDetail } from '../../api/types';
import { getCollectionId } from '../../lib/annotations';

type State =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'ready'; detail: CollectionDetail }
  | { status: 'error' };

/**
 * Right-column entity card rendering the connected Bruno collection's root
 * README as markdown. Resolves the collection id from the
 * `bruno.dev/collection-id` annotation, falling back to a runtime connection
 * lookup. Renders nothing (returns `null`) while loading, when the entity has
 * no linked collection, on error, or when the collection has no README — so no
 * empty overview card is shown.
 */
export function CollectionOverviewCard(): JSX.Element | null {
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);

  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    if (annotationCollectionId) {
      brunoApi
        .getCollection(annotationCollectionId)
        .then((detail) => {
          if (!cancelled) {
            setState({ status: 'ready', detail });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setState({ status: 'error' });
          }
        });
      return () => {
        cancelled = true;
      };
    }

    brunoApi
      .getConnection(entityRef)
      .then((record) => {
        if (cancelled) {
          return undefined;
        }
        if (!record) {
          setState({ status: 'hidden' });
          return undefined;
        }
        return brunoApi.getCollection(record.collectionId).then((detail) => {
          if (!cancelled) {
            setState({ status: 'ready', detail });
          }
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [brunoApi, entityRef, annotationCollectionId]);

  if (state.status !== 'ready') {
    return null;
  }

  const readme = state.detail.collection.readme;
  if (!readme) {
    return null;
  }

  return (
    <InfoCard title="Collection Overview">
      <MarkdownContent content={readme} dialect="gfm" />
    </InfoCard>
  );
}
