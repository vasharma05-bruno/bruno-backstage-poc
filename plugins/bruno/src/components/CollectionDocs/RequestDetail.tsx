import { useState } from 'react';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import Tabs from '@material-ui/core/Tabs';
import Tab from '@material-ui/core/Tab';
import Table from '@material-ui/core/Table';
import TableHead from '@material-ui/core/TableHead';
import TableBody from '@material-ui/core/TableBody';
import TableRow from '@material-ui/core/TableRow';
import TableCell from '@material-ui/core/TableCell';
import { makeStyles } from '@material-ui/core/styles';
import { CodeSnippet, MarkdownContent } from '@backstage/core-components';
import type { Environment, KeyValue, RequestItem, RequestParam } from '../../api/types';
import { MethodBadge } from '../MethodBadge';
import { TryItOut } from './TryItOut';

const useStyles = makeStyles((theme) => ({
  urlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(1)
  },
  url: {
    fontFamily: 'monospace',
    wordBreak: 'break-all'
  },
  section: {
    marginTop: theme.spacing(2)
  }
}));

const TABS = [
  'Headers',
  'Params',
  'Body',
  'Auth',
  'Docs',
  'Tests',
  'Try it out'
] as const;

/** Right-pane detail for a selected request: method+URL and tabbed sections. */
export function RequestDetail(props: {
  item: RequestItem;
  environments: Environment[];
}) {
  const classes = useStyles();
  const { item, environments } = props;
  const [tab, setTab] = useState(0);

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        {item.name}
      </Typography>
      <Box className={classes.urlRow}>
        <MethodBadge method={item.method} />
        <Typography className={classes.url} variant="body2">
          {item.url}
        </Typography>
      </Box>

      <Tabs
        value={tab}
        onChange={(_e, v) => setTab(v)}
        indicatorColor="primary"
        textColor="primary"
        variant="scrollable"
        scrollButtons="auto"
      >
        {TABS.map((t) => (
          <Tab key={t} label={t} />
        ))}
      </Tabs>

      <Box className={classes.section}>
        {tab === 0 && <KeyValueTable rows={item.headers} empty="No headers" />}
        {tab === 1 && <ParamsTable rows={item.params} />}
        {tab === 2 && <BodySection item={item} />}
        {tab === 3 && <AuthSection item={item} />}
        {tab === 4 && <DocsSection docs={item.docs} />}
        {tab === 5 && <TestsSection item={item} />}
        {tab === 6 && <TryItOut item={item} environments={environments} />}
      </Box>
    </Box>
  );
}

function KeyValueTable(props: { rows: KeyValue[]; empty: string }) {
  if (!props.rows.length) {
    return <EmptyNote text={props.empty} />;
  }
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Name</TableCell>
          <TableCell>Value</TableCell>
          <TableCell>Enabled</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {props.rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell>
              <code>{r.name}</code>
            </TableCell>
            <TableCell>{r.value}</TableCell>
            <TableCell>{r.enabled === false ? 'no' : 'yes'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ParamsTable(props: { rows: RequestParam[] }) {
  if (!props.rows.length) {
    return <EmptyNote text="No params" />;
  }
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Name</TableCell>
          <TableCell>Value</TableCell>
          <TableCell>Type</TableCell>
          <TableCell>Enabled</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {props.rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell>
              <code>{r.name}</code>
            </TableCell>
            <TableCell>{r.value}</TableCell>
            <TableCell>{r.type}</TableCell>
            <TableCell>{r.enabled === false ? 'no' : 'yes'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BodySection(props: { item: RequestItem }) {
  const body = props.item.body;
  if (!body || body.mode === 'none') {
    return <EmptyNote text="No body" />;
  }
  if (body.raw !== undefined) {
    const language
      = body.mode === 'json' ? 'json' : body.mode === 'xml' ? 'xml' : 'text';
    return (
      <Box>
        <Typography variant="caption" color="textSecondary">
          mode: {body.mode}
        </Typography>
        <CodeSnippet language={language} text={body.raw} showCopyCodeButton />
      </Box>
    );
  }
  if (body.form) {
    return <KeyValueTable rows={body.form} empty="No form fields" />;
  }
  return <EmptyNote text={`mode: ${body.mode}`} />;
}

function AuthSection(props: { item: RequestItem }) {
  const auth = props.item.auth;
  if (!auth || auth.mode === 'none') {
    return <EmptyNote text="No auth (mode: none)" />;
  }
  const { mode, ...rest } = auth;
  return (
    <Box>
      <Typography variant="body2" gutterBottom>
        Mode: <strong>{mode}</strong>
      </Typography>
      {Object.keys(rest).length > 0 && (
        <CodeSnippet language="json" text={JSON.stringify(rest, null, 2)} />
      )}
    </Box>
  );
}

function DocsSection(props: { docs?: string }) {
  if (!props.docs) {
    return <EmptyNote text="No documentation" />;
  }
  return <MarkdownContent content={props.docs} />;
}

function TestsSection(props: { item: RequestItem }) {
  const { tests, assertions } = props.item;
  if (!tests && (!assertions || assertions.length === 0)) {
    return <EmptyNote text="No tests or assertions" />;
  }
  return (
    <Box>
      {assertions && assertions.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Expression</TableCell>
              <TableCell>Op</TableCell>
              <TableCell>Value</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {assertions.map((a, i) => (
              <TableRow key={i}>
                <TableCell>
                  <code>{a.expr}</code>
                </TableCell>
                <TableCell>{a.op}</TableCell>
                <TableCell>{a.value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {tests && (
        <Box mt={assertions && assertions.length ? 2 : 0}>
          <CodeSnippet language="javascript" text={tests} />
        </Box>
      )}
    </Box>
  );
}

function EmptyNote(props: { text: string }) {
  return (
    <Typography variant="body2" color="textSecondary">
      {props.text}
    </Typography>
  );
}
