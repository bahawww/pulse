/**
 * Terminal colour schemes. `site` follows the dashboard's light/dark tokens;
 * every other scheme is fixed and ignores the site theme.
 */

export interface TermScheme {
  readonly id: string;
  readonly name: string;
  readonly dark: boolean;
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  /** Selection fill, with alpha. */
  readonly selection: string;
  /** 16 ANSI colours, black to bright white. */
  readonly ansi: readonly string[];
}

const s = (
  id: string,
  name: string,
  dark: boolean,
  background: string,
  foreground: string,
  cursor: string,
  selection: string,
  ansi: string,
): TermScheme => ({ id, name, dark, background, foreground, cursor, selection, ansi: ansi.split(' ') });

export const SCHEMES: readonly TermScheme[] = [
  s('tokyo-night', 'Tokyo Night', true, '#1a1b26', '#c0caf5', '#c0caf5', 'rgba(122,162,247,0.30)',
    '#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #ff899d #9fe044 #faba4a #8db0ff #c7a9ff #a4daff #c0caf5'),
  s('catppuccin-mocha', 'Catppuccin Mocha', true, '#1e1e2e', '#cdd6f4', '#f5e0dc', 'rgba(147,153,178,0.32)',
    '#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f37799 #89d88b #ebd391 #74a8fc #f2aede #6bd7ca #a6adc8'),
  s('dracula', 'Dracula', true, '#282a36', '#f8f8f2', '#f8f8f2', 'rgba(68,71,90,0.85)',
    '#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff'),
  s('nord', 'Nord', true, '#2e3440', '#d8dee9', '#d8dee9', 'rgba(76,86,106,0.75)',
    '#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4'),
  s('gruvbox-dark', 'Gruvbox Dark', true, '#282828', '#ebdbb2', '#ebdbb2', 'rgba(102,92,84,0.70)',
    '#282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2'),
  s('one-dark', 'One Dark', true, '#282c34', '#abb2bf', '#528bff', 'rgba(62,68,81,0.85)',
    '#282c34 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf #5c6370 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #ffffff'),
  s('rose-pine', 'Rosé Pine', true, '#191724', '#e0def4', '#524f67', 'rgba(110,106,134,0.35)',
    '#26233a #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4 #6e6a86 #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4'),
  s('synthwave', 'Synthwave 84', true, '#241b2f', '#f8f8f2', '#ff7edb', 'rgba(255,126,219,0.25)',
    '#2a2139 #fe4450 #72f1b8 #fede5d #03edf9 #ff7edb #03edf9 #f8f8f2 #614d85 #fe4450 #72f1b8 #f3e70f #03edf9 #ff7edb #03edf9 #ffffff'),
  s('matrix', 'Matrix', true, '#020a04', '#3cff6b', '#3cff6b', 'rgba(60,255,107,0.22)',
    '#021b0a #2fbf55 #3cff6b #9cff3c #1f9e45 #52d273 #7dffa0 #b7ffc8 #0d4a1e #45e06a #7dff9c #c4ff7a #36c862 #8cf0a8 #b0ffc6 #e6ffee'),
  s('solarized-dark', 'Solarized Dark', true, '#002b36', '#839496', '#93a1a1', 'rgba(7,54,66,0.95)',
    '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #586e75 #cb4b16 #93a1a1 #b58900 #839496 #6c71c4 #2aa198 #fdf6e3'),
  s('solarized-light', 'Solarized Light', false, '#fdf6e3', '#657b83', '#586e75', 'rgba(147,161,161,0.30)',
    '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #586e75 #cb4b16 #93a1a1 #b58900 #839496 #6c71c4 #2aa198 #fdf6e3'),
  s('github-light', 'GitHub Light', false, '#ffffff', '#24292f', '#0969da', 'rgba(9,105,218,0.20)',
    '#24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781 #57606a #a40e26 #1a7f37 #633c01 #218bff #a475f9 #3192aa #8c959f'),
  s('catppuccin-latte', 'Catppuccin Latte', false, '#eff1f5', '#4c4f69', '#dc8a78', 'rgba(124,127,147,0.25)',
    '#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #de293e #49af3d #eea02d #456eff #fe85d8 #2d9fa8 #bcc0cc'),
];

export const SITE_SCHEME = 'site';

export const SCHEME_IDS = new Set([SITE_SCHEME, ...SCHEMES.map((x) => x.id)]);
