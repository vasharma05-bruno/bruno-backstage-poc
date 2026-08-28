import { createTheme } from '@material-ui/core/styles';
import { brunoBrand } from './brand';

/**
 * Locks the brand accent for both modes, plus the AA-darkened text variant
 * derived from the light-mode value — the kind of thing that drifts silently
 * once a dozen components consume it by name.
 */
describe('brunoBrand', () => {
  const brand = (type: 'light' | 'dark') =>
    brunoBrand(createTheme({ palette: { type } }));

  it('uses the light-mode brand accent on light surfaces', () => {
    expect(brand('light').accent).toBe('hsl(33, 80%, 46%)');
  });

  it('uses the dark-mode brand accent on dark surfaces', () => {
    expect(brand('dark').accent).toBe('hsl(39, 74%, 59%)');
  });

  it('darkens the accent for text use in light mode only', () => {
    expect(brand('light').accentText).toBe('hsl(33, 80%, 36%)');
    expect(brand('dark').accentText).toBe(brand('dark').accent);
  });

  it('derives every wash and border from the mode accent hue', () => {
    const light = brand('light');
    expect(light.wash).toBe('hsla(33, 80%, 46%, 0.08)');
    expect(light.border).toBe('hsla(33, 80%, 46%, 0.35)');
    expect(brand('dark').wash).toBe('hsla(39, 74%, 59%, 0.1)');
  });
});
