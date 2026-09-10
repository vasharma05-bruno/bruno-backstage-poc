import { useState } from 'react';
import Box from '@material-ui/core/Box';
import FormControl from '@material-ui/core/FormControl';
import FormControlLabel from '@material-ui/core/FormControlLabel';
import FormLabel from '@material-ui/core/FormLabel';
import Radio from '@material-ui/core/Radio';
import RadioGroup from '@material-ui/core/RadioGroup';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';

/**
 * Where a link gets recorded.
 *
 * `pr` edits the collection's `catalog-info.yaml`, so the link lives in source
 * control: reviewable, and it travels with the repository. `runtime` writes a
 * row in the `bruno` backend, so the link lives in this instance only, appears
 * within seconds and is undone with one click.
 *
 * The pull request is the default wherever it is possible, and that ordering is
 * the whole point of offering a choice rather than picking for the user: source
 * control is the better answer, and "no descriptor to edit" is the only reason
 * to settle for the other one.
 */
export type LinkMethod = 'pr' | 'runtime';

const useStyles = makeStyles((theme) => ({
  root: {
    display: 'block',
    marginTop: theme.spacing(2)
  },
  legend: {
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  /** Hangs each explanation under its own radio, aligned with the label rather
   *  than with the button, so the two options read as two blocks. */
  detail: {
    marginLeft: theme.spacing(4),
    marginBottom: theme.spacing(1.5)
  },
  /** Sits directly under the advice in the dead-end rendering, where there is
   *  no radio to hang off and so no indent to match. */
  afterAdvice: {
    marginTop: theme.spacing(1)
  }
}));

/**
 * Holds the method choice, collapsing it to whichever method is actually
 * available — and to `undefined` when neither is.
 *
 * The collapse is why this is a hook and not a `useState` at each call site.
 * Both link dialogs can be pointed at a collection with no editable descriptor
 * — the API-side one a candidate at a time, as the picker changes — and the
 * radio must not leave a *selected* pull-request option that the primary button
 * would then refuse to act on. `method` is therefore what will actually happen,
 * and the remembered choice comes back if the user picks a collection that does
 * have a descriptor.
 *
 * `runtimePossible` is `bruno.allowRuntimeWrites`, and it makes the same
 * collapse run the other way: with instance-local writes off, a collection that
 * HAS a descriptor is a pull request and nothing else. The two of them off
 * together is a real state and not a bug — a `bruno.collections[]` entry on an
 * instance that keeps source control authoritative — and `undefined` is how
 * this hook says so, rather than naming a method the dialog would then be
 * unable to carry out. Every caller reads it as "there is nothing to press".
 */
export function useLinkMethod(opts: {
  prPossible: boolean;
  runtimePossible: boolean;
}): {
  method: LinkMethod | undefined;
  setMethod: (method: LinkMethod) => void;
  reset: () => void;
} {
  const { prPossible, runtimePossible } = opts;
  const [chosen, setChosen] = useState<LinkMethod>('pr');
  const method
    = prPossible && runtimePossible
      ? chosen
      : prPossible
        ? 'pr'
        : runtimePossible
          ? 'runtime'
          : undefined;
  return {
    method,
    setMethod: setChosen,
    // Back to the recommended one. A user who linked a `bruno.collections[]`
    // collection at runtime because it had no descriptor should not find the
    // next collection — which may well have one — pre-set to the fallback.
    reset: () => setChosen('pr')
  };
}

/**
 * The "where to record the link" step, shared by both link dialogs.
 *
 * `advice` does double duty and is the reason this component needs no
 * `prPossible` flag of its own: `useDescriptorAdvice` returns `undefined`
 * exactly when a pull request can be opened, so its presence both disables that
 * option and explains why — in the same words the unlink dialog and the empty
 * card use, which is what keeps five situations from being described five ways.
 *
 * Before this existed those five cases ENDED the flow: the dialog rendered the
 * advice and a Close button. The advice is unchanged; what changed is that it
 * is now the reason one option is unavailable rather than the reason there is
 * nothing to do — unless `runtimeAvailable` is false, in which case it is both
 * again, and this renders the dead end deliberately.
 *
 * Three shapes, because a radio group is only honest when there is a choice:
 *
 *  - **Both available.** The group, pull request first and recommended.
 *  - **Pull request only** (`bruno.allowRuntimeWrites` off, descriptor
 *    editable). One paragraph saying what will happen. A group with one
 *    selectable option asks the user to make a decision that has already been
 *    made for them, and a disabled second radio would advertise a feature the
 *    operator switched off — which reads as something to go and enable.
 *  - **Neither.** The advice alone, plus the one sentence that says the other
 *    door is shut too. The disabled radio pair is the wrong rendering here for
 *    the same reason: nothing on this screen is selectable, so nothing should
 *    look like it is.
 *
 * The runtime option, when it is shown, is never disabled — `runtimeAvailable`
 * removes it rather than greying it out.
 */
export function LinkMethodChoice(props: {
  method: LinkMethod | undefined;
  onChange: (method: LinkMethod) => void;
  /** From `useDescriptorAdvice`; `undefined` means a pull request is possible. */
  advice?: JSX.Element;
  /** `bruno.allowRuntimeWrites` — whether an instance-local link is offered. */
  runtimeAvailable: boolean;
  disabled?: boolean;
  /** What the link adds — one ref, or a list of them — for the PR explanation. */
  target: JSX.Element;
}): JSX.Element {
  const { method, onChange, advice, runtimeAvailable, disabled, target }
    = props;
  const classes = useStyles();

  /** What a pull request would do, worded the same in both places it appears. */
  const prExplanation = (
    <Typography variant="body2" color="textSecondary">
      Adds {target} to <code>spec.partOf</code> in the collection&apos;s{' '}
      <code>catalog-info.yaml</code>. The relation appears once the pull request
      is merged and Backstage re-reads the file.
    </Typography>
  );

  if (!runtimeAvailable) {
    return (
      <Box className={classes.root}>
        {advice ?? prExplanation}
        {advice && (
          <Typography
            variant="body2"
            color="textSecondary"
            className={classes.afterAdvice}
          >
            Recording the link in this Backstage instance instead is turned off
            here (<code>bruno.allowRuntimeWrites</code>), so there is nothing
            this dialog can do for this collection.
          </Typography>
        )}
      </Box>
    );
  }

  return (
    <FormControl component="fieldset" className={classes.root}>
      <FormLabel component="legend">
        <Typography
          variant="caption"
          color="textSecondary"
          className={classes.legend}
        >
          Where to record the link
        </Typography>
      </FormLabel>
      <RadioGroup
        name="bruno-link-method"
        value={method ?? ''}
        onChange={(event) => onChange(event.target.value as LinkMethod)}
      >
        <FormControlLabel
          value="pr"
          disabled={Boolean(advice) || disabled}
          control={<Radio size="small" color="primary" />}
          label={
            advice
              ? 'Open a pull request'
              : 'Open a pull request (recommended)'
          }
        />
        <Box className={classes.detail}>{advice ?? prExplanation}</Box>

        <FormControlLabel
          value="runtime"
          disabled={disabled}
          control={<Radio size="small" color="primary" />}
          label="Link in this Backstage instance"
        />
        <Box className={classes.detail}>
          <Typography variant="body2" color="textSecondary">
            Records the link in the Bruno backend&apos;s own database and
            changes nothing in source control. The relation appears within a few
            seconds and <strong>Unlink</strong> removes it again — but it lives
            only in this instance: it is not reviewed, and it does not travel
            with the collection&apos;s repository.
          </Typography>
        </Box>
      </RadioGroup>
    </FormControl>
  );
}
