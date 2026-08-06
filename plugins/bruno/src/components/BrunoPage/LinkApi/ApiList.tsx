import { getEntityRelations } from '@backstage/plugin-catalog-react';
import {
  RELATION_OWNED_BY,
  stringifyEntityRef
} from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import ListItemText from '@material-ui/core/ListItemText';
import Chip from '@material-ui/core/Chip';
import Box from '@material-ui/core/Box';

/** View model for an API entity that has no linked Bruno collection yet. */
export interface UnlinkedApi {
  entityRef: string;
  name: string;
  specType?: string;
  owner?: string;
}

/** Project a catalog `Entity` into the list view model. */
export function toUnlinkedApi(entity: Entity): UnlinkedApi {
  const specType
    = typeof entity.spec?.type === 'string' ? entity.spec.type : undefined;
  const ownedBy = getEntityRelations(entity, RELATION_OWNED_BY)[0]?.name;
  const specOwner
    = typeof entity.spec?.owner === 'string' ? entity.spec.owner : undefined;
  const owner = ownedBy ?? specOwner;
  return {
    entityRef: stringifyEntityRef(entity),
    name: entity.metadata.title ?? entity.metadata.name,
    specType,
    owner: owner || undefined
  };
}

/** Selectable list of unlinked API entities. */
export function ApiList(props: {
  apis: UnlinkedApi[];
  selectedRef?: string;
  onSelect: (entityRef: string) => void;
}): JSX.Element {
  const { apis, selectedRef, onSelect } = props;
  return (
    <List>
      {apis.map((api) => (
        <ListItem
          button
          key={api.entityRef}
          selected={api.entityRef === selectedRef}
          onClick={() => onSelect(api.entityRef)}
        >
          <ListItemText
            primary={api.name}
            secondary={
              (api.specType || api.owner) && (
                <Box display="flex" flexWrap="wrap" gridGap={4} mt={0.5}>
                  {api.specType && (
                    <Chip label={api.specType} size="small" />
                  )}
                  {api.owner && <Chip label={api.owner} size="small" />}
                </Box>
              )
            }
            secondaryTypographyProps={{ component: 'div' }}
          />
        </ListItem>
      ))}
    </List>
  );
}
