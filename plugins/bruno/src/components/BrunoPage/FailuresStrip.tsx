import { WarningPanel } from '@backstage/core-components';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import ListItemText from '@material-ui/core/ListItemText';
import type { SourceFailure } from '../../api/types';

/** Warning strip listing sources that failed to load on the last refresh. */
export function FailuresStrip(props: {
  failures: SourceFailure[];
}): JSX.Element {
  const { failures } = props;
  return (
    <WarningPanel severity="warning" title="Some sources failed to load">
      <List dense disablePadding>
        {failures.map((failure) => (
          <ListItem key={failure.id} dense disableGutters>
            <ListItemText
              primary={failure.target}
              secondary={failure.error}
            />
          </ListItem>
        ))}
      </List>
    </WarningPanel>
  );
}
