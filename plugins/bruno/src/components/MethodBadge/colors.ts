// Shared colour tokens for HTTP-method / status badges. Colours live in this
// module (exempt from the no-hardcoded-colour rule) so components consume them
// by name rather than embedding hex literals.

/** Colour for a response-status chip: green for <400, red otherwise. */
export const statusColor = (status: number): string =>
  status < 400 ? '#2e7d32' : '#c62828';

/** Foreground colour for coloured badges. */
export const badgeTextColor = '#fff';
