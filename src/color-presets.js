// Built-in terminal colour presets.
// Each preset has a `dark` and `light` palette with: background, foreground,
// selectionBg, and ansi (16-element array in xterm order: black→white, bright-black→bright-white).

export const COLOR_PRESETS = {
  vibe: {
    label: 'Vibe',
    dark: {
      background: '#111111',
      foreground: '#d9d4c7',
      selectionBg: '#2a2a2a',
      ansi: [
        '#111111', '#ff6b57', '#98c379', '#e5c07b',
        '#61afef', '#c678dd', '#56b6c2', '#d9d4c7',
        '#5a6374', '#ff8578', '#b0d98b', '#f0d58a',
        '#7eb7ff', '#d9a5e8', '#7fd8e6', '#ffffff',
      ],
    },
    light: {
      background: '#f4f0ea',
      foreground: '#686c82',
      selectionBg: '#dbd6d0',
      ansi: [
        '#686c82', '#c94038', '#229055', '#b07200',
        '#1f6dad', '#8344a8', '#1a8895', '#686c80',
        '#5e6274', '#e8806a', '#48b86a', '#d88810',
        '#2878b8', '#9058b8', '#18a898', '#848898',
      ],
    },
  },
  dracula: {
    label: 'Dracula',
    dark: {
      background: '#282a36',
      foreground: '#f8f8f2',
      selectionBg: '#44475a',
      ansi: [
        '#21222c', '#ff5555', '#50fa7b', '#f1fa8c',
        '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
        '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5',
        '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
      ],
    },
    light: {
      background: '#f4f0ea',
      foreground: '#686c82',
      selectionBg: '#dbd6d0',
      ansi: [
        '#686c82', '#c94038', '#229055', '#b07200',
        '#1f6dad', '#8344a8', '#1a8895', '#686c80',
        '#5e6274', '#e8806a', '#48b86a', '#d88810',
        '#2878b8', '#9058b8', '#18a898', '#848898',
      ],
    },
  },
  'one-dark': {
    label: 'One Dark',
    dark: {
      background: '#282c34',
      foreground: '#abb2bf',
      selectionBg: '#3e4451',
      ansi: [
        '#282c34', '#e06c75', '#98c379', '#e5c07b',
        '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
        '#5c6370', '#e06c75', '#98c379', '#e5c07b',
        '#61afef', '#c678dd', '#56b6c2', '#ffffff',
      ],
    },
    light: {
      background: '#f4f0ea',
      foreground: '#686c82',
      selectionBg: '#dbd6d0',
      ansi: [
        '#686c82', '#c94038', '#229055', '#b07200',
        '#1f6dad', '#8344a8', '#1a8895', '#686c80',
        '#5e6274', '#e8806a', '#48b86a', '#d88810',
        '#2878b8', '#9058b8', '#18a898', '#848898',
      ],
    },
  },
  solarized: {
    label: 'Solarized',
    dark: {
      background: '#002b36',
      foreground: '#839496',
      selectionBg: '#073642',
      ansi: [
        '#073642', '#dc322f', '#859900', '#b58900',
        '#268bd2', '#d33682', '#2aa198', '#eee8d5',
        '#002b36', '#cb4b16', '#586e75', '#657b83',
        '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
      ],
    },
    light: {
      background: '#fdf6e3',
      foreground: '#657b83',
      selectionBg: '#eee8d5',
      ansi: [
        '#073642', '#dc322f', '#859900', '#b58900',
        '#268bd2', '#d33682', '#2aa198', '#eee8d5',
        '#002b36', '#cb4b16', '#586e75', '#657b83',
        '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
      ],
    },
  },
  nord: {
    label: 'Nord',
    dark: {
      background: '#2e3440',
      foreground: '#d8dee9',
      selectionBg: '#4c566a',
      ansi: [
        '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b',
        '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
        '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b',
        '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
      ],
    },
    light: {
      background: '#eceff4',
      foreground: '#2e3440',
      selectionBg: '#d8dee9',
      ansi: [
        '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b',
        '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
        '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b',
        '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
      ],
    },
  },
  gruvbox: {
    label: 'Gruvbox',
    dark: {
      background: '#282828',
      foreground: '#ebdbb2',
      selectionBg: '#3c3836',
      ansi: [
        '#282828', '#cc241d', '#98971a', '#d79921',
        '#458588', '#b16286', '#689d6a', '#a89984',
        '#928374', '#fb4934', '#b8bb26', '#fabd2f',
        '#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
      ],
    },
    light: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      selectionBg: '#d5c4a1',
      ansi: [
        '#fbf1c7', '#cc241d', '#98971a', '#d79921',
        '#458588', '#b16286', '#689d6a', '#7c6f64',
        '#928374', '#9d0006', '#79740e', '#b57614',
        '#076678', '#8f3f71', '#427b58', '#3c3836',
      ],
    },
  },
};

export const DEFAULT_PRESET_ID = 'vibe';

export function getPreset(id) {
  return COLOR_PRESETS[id] ?? COLOR_PRESETS[DEFAULT_PRESET_ID];
}
