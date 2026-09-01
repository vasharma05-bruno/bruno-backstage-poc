import type { ReactNode } from 'react';
import Typography from '@material-ui/core/Typography';
import Tooltip from '@material-ui/core/Tooltip';
import { Link } from '@backstage/core-components';
import type { ChangeRoute } from '../../lib/changeRoute';
import { changeRouteLabel } from '../../lib/changeRoute';

/**
 * One sentence telling the operator where a change to this collection has to be
 * made, and by whom.
 *
 * Exists so the three places that ask the question — the Related APIs empty
 * state, the Unlink dialog, the Link dialog — cannot drift apart on the answer.
 * They did drift: the empty state told every collection to edit a
 * `catalog-info.yaml`, including the ones defined in `app-config.yaml`, which
 * sent their operators looking for a file that does not exist.
 *
 * The caller supplies the change twice because the same edit is spelled
 * differently in the two files: `spec.partOf` in a descriptor is `partOf` in a
 * `bruno.collections[]` entry, and a descriptor names the whole entity where the
 * config entry names one list item.
 */
export function ChangeRouteHint(props: {
  route: ChangeRoute;
  /** The edit, phrased for a `catalog-info.yaml`. */
  descriptorChange: ReactNode;
  /** The same edit, phrased for a `bruno.collections[]` entry. */
  configChange: ReactNode;
  className?: string;
}): JSX.Element {
  const { route, descriptorChange, configChange, className } = props;

  let body: ReactNode;
  switch (route.via) {
    case 'pull-request':
      body = (
        <>
          Backstage can make this change for you: it opens a pull request that
          {' '}{descriptorChange} in this collection&apos;s{' '}
          <Link to={route.descriptorUrl}>
            <code>catalog-info.yaml</code>
          </Link>
          . The catalog updates once that pull request is merged.
        </>
      );
      break;
    case 'descriptor':
      // Not a GitHub URL, so `lib/unlinkPr.ts` has no API to call. Naming the
      // file is the whole value here — the operator should not have to hunt for
      // which of their repos declares this entity.
      body = (
        <>
          This collection is declared by{' '}
          <Link to={route.descriptorUrl}>{route.descriptorUrl}</Link>. Edit that
          file to {descriptorChange}. Backstage opens pull requests on GitHub
          only, so this one has to be committed by hand.
        </>
      );
      break;
    case 'app-config':
      body = (
        <>
          This collection comes from a <code>bruno.collections[]</code> entry in
          your Backstage <code>app-config.yaml</code>, so it has no{' '}
          <code>catalog-info.yaml</code> to edit. {configChange}, then restart
          Backstage.
        </>
      );
      break;
    case 'local-file':
      body = (
        <>
          This collection is declared by a <code>catalog-info.yaml</code> on the
          Backstage host&apos;s own disk, which is not in source control. Edit
          that file to {descriptorChange}.
        </>
      );
      break;
    default:
      body = (
        <>
          This entity carries no resolvable{' '}
          <code>backstage.io/managed-by-location</code>, so the file that
          declares it cannot be identified.
        </>
      );
  }

  return (
    <Typography variant="body2" color="textSecondary" className={className}>
      {body}
    </Typography>
  );
}

/**
 * The header's "Managed by" value: what declares this collection, linked when
 * there is somewhere to go.
 *
 * Worth a row of its own because it is the fact that decides every other
 * management question about the collection, and until it is on the page the
 * operator only finds out which world they are in by opening a dialog.
 */
export function ManagedByValue(props: { route: ChangeRoute }): JSX.Element {
  const { route } = props;
  const label = changeRouteLabel(route);

  const tooltip
    = route.via === 'app-config'
      ? 'Declared by a bruno.collections[] entry in app-config.yaml. Changes '
      + 'are made there and take effect on restart.'
      : route.via === 'local-file'
        ? 'Declared by a catalog-info.yaml on the Backstage host’s disk.'
        : route.via === 'unknown'
          ? 'This entity names no location the catalog can resolve.'
          : route.createdInBackstage
            ? 'Declared by a catalog-info.yaml this plugin generated. Changes '
            + 'are made by pull request against that file.'
            : 'Declared by a catalog-info.yaml in source control. Changes are '
              + 'made by pull request against that file.';

  return (
    <Tooltip title={tooltip}>
      <span>
        {route.via === 'pull-request' || route.via === 'descriptor'
          ? <Link to={route.descriptorUrl}>{label}</Link>
          : label}
      </span>
    </Tooltip>
  );
}
