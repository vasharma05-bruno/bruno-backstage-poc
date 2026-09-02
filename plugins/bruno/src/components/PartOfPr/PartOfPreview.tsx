import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { CodeSnippet, Link } from '@backstage/core-components';
import type { PartOfPlan } from '../../lib/unlinkPr';

/** The layout every `spec.partOf` dialog shares. */
export const usePartOfStyles = makeStyles((theme) => ({
  panes: {
    'display': 'grid',
    'gridTemplateColumns': '1fr 1fr',
    'gap': theme.spacing(2),
    // Two full descriptors side by side would push the dialog past the fold.
    '& > *': {
      maxHeight: 260,
      overflow: 'auto'
    }
  },
  paneLabel: {
    display: 'block',
    marginBottom: theme.spacing(0.5),
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  detail: {
    marginTop: theme.spacing(1)
  }
}));

/**
 * What the pull request will do: which file in which repository, and the
 * descriptor before and after the edit.
 *
 * The point of showing the real diff is that this flow edits a file the reader
 * did not open — so the last step before a branch exists is the file itself,
 * not a description of it. Identical for all three flows, because the plan it
 * renders already carries the direction's own edit.
 */
export function PartOfPreview(props: { plan: PartOfPlan }): JSX.Element {
  const { plan } = props;
  const classes = usePartOfStyles();

  return (
    <>
      <Typography variant="body2">
        The pull request updates <code>{plan.path}</code> in{' '}
        <Link to={plan.repoUrl}>
          {plan.owner}/{plan.repo}
        </Link>{' '}
        on a new branch <code>{plan.branch}</code>, based on{' '}
        <code>{plan.baseBranch}</code>.
      </Typography>
      <Box className={classes.detail}>
        <Box className={classes.panes}>
          {([['Before', plan.before], ['After', plan.after]] as const).map(
            ([label, text]) => (
              <Box key={label}>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  className={classes.paneLabel}
                >
                  {label}
                </Typography>
                <CodeSnippet text={text} language="yaml" />
              </Box>
            )
          )}
        </Box>
      </Box>
    </>
  );
}
