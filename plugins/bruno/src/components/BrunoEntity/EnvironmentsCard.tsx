import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { Table } from '@backstage/core-components';
import type { TableColumn } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { environments, hasEnvironments } from '../../lib/brunoEntity';
import { BrunoInfoCard } from '../BrunoInfoCard';

const useStyles = makeStyles((theme) => ({
  message: {
    padding: theme.spacing(2)
  }
}));

/** One row per environment name. */
interface EnvironmentRow {
  name: string;
}

const columns: TableColumn<EnvironmentRow>[] = [
  { title: 'Environment', field: 'name' }
];

/**
 * Overview card listing the collection's environments.
 *
 * Reads `spec.environments` straight off the entity — `BrunoKindProcessor`
 * writes it as a string ARRAY, which is also what makes a catalog facet query
 * able to count UNIQUE environments across every collection.
 *
 * Three distinct states, because they mean different things to the reader: the
 * key is missing (the collection has not been read yet — the processor writes
 * these fields a cycle after the entity appears), the key is an empty list (the
 * collection genuinely defines no environments), or there are names to show.
 * Collapsing the first two into one empty state would make a not-yet-processed
 * collection look like a finished, environment-less one.
 */
export function EnvironmentsCard(): JSX.Element {
  const classes = useStyles();
  const { entity } = useEntity();
  const names = environments(entity);

  let body: JSX.Element;
  if (!hasEnvironments(entity)) {
    body = (
      <Typography
        variant="body2"
        color="textSecondary"
        className={classes.message}
      >
        — waiting for the next collection sync.
      </Typography>
    );
  } else if (names.length === 0) {
    body = (
      <Typography
        variant="body2"
        color="textSecondary"
        className={classes.message}
      >
        No environments found in this collection.
      </Typography>
    );
  } else {
    body = (
      <Table
        options={{ search: false, paging: false, toolbar: false, padding: 'dense' }}
        columns={columns}
        data={names.map((name) => ({ name }))}
      />
    );
  }

  return (
    <BrunoInfoCard title="Environments" noPadding>
      {body}
    </BrunoInfoCard>
  );
}
