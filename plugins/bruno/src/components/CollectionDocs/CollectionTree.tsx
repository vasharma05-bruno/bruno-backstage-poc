import { Fragment } from 'react';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import ListItemText from '@material-ui/core/ListItemText';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import FolderIcon from '@material-ui/icons/Folder';
import { makeStyles } from '@material-ui/core/styles';
import type { Item } from '../../api/types';
import { isFolderItem, isRequestItem } from '../../api/types';
import { MethodBadge } from '../MethodBadge';

const useStyles = makeStyles((theme) => ({
  requestRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1)
  },
  folderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5)
  }
}));

/**
 * Recursive left-pane tree of folders (with an icon) and requests (method
 * badge + name). Selection is keyed by the path-based id from `tree.ts`.
 */
export function CollectionTree(props: {
  items: Item[];
  selectedId?: string;
  onSelect: (id: string) => void;
  prefix?: string;
}) {
  const classes = useStyles();
  const { items, selectedId, onSelect, prefix = '' } = props;

  return (
    <List dense disablePadding>
      {items.map((item, idx) => {
        const id = `${prefix}${idx}`;
        if (isFolderItem(item)) {
          return (
            <Fragment key={id}>
              <ListItem dense>
                <Box className={classes.folderRow}>
                  <FolderIcon fontSize="small" color="action" />
                  <Typography variant="body2">
                    <strong>{item.name}</strong>
                  </Typography>
                </Box>
              </ListItem>
              <Box pl={2}>
                <CollectionTree
                  items={item.items}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  prefix={`${id}.`}
                />
              </Box>
            </Fragment>
          );
        }
        if (isRequestItem(item)) {
          return (
            <ListItem
              key={id}
              button
              dense
              selected={selectedId === id}
              onClick={() => onSelect(id)}
            >
              <Box className={classes.requestRow}>
                <MethodBadge method={item.method} />
                <ListItemText primary={item.name} />
              </Box>
            </ListItem>
          );
        }
        return null;
      })}
    </List>
  );
}
