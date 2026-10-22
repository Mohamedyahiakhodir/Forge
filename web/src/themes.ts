import type { Extension } from '@codemirror/state';
import {
  dracula, monokai, githubDark, githubLight, solarizedDark, solarizedLight, nord, tokyoNight, tokyoNightDay,
  materialDark, materialLight, gruvboxDark, gruvboxLight, vscodeDark, vscodeLight, okaidia, xcodeLight, xcodeDark,
  androidstudio, duotoneDark, eclipse, sublime, bespin, atomone, aura, quietlight, tomorrowNightBlue, abyss,
} from '@uiw/codemirror-themes-all';
import { oneDark } from '@codemirror/theme-one-dark';

export interface ThemeInfo { id: string; label: string; dark: boolean; ext: Extension }

export const THEMES: ThemeInfo[] = [
  { id: 'dracula', label: 'Dracula', dark: true, ext: dracula },
  { id: 'monokai', label: 'Monokai', dark: true, ext: monokai },
  { id: 'onedark', label: 'One Dark', dark: true, ext: oneDark },
  { id: 'githubDark', label: 'GitHub Dark', dark: true, ext: githubDark },
  { id: 'githubLight', label: 'GitHub Light', dark: false, ext: githubLight },
  { id: 'solarizedDark', label: 'Solarized Dark', dark: true, ext: solarizedDark },
  { id: 'solarizedLight', label: 'Solarized Light', dark: false, ext: solarizedLight },
  { id: 'nord', label: 'Nord', dark: true, ext: nord },
  { id: 'tokyoNight', label: 'Tokyo Night', dark: true, ext: tokyoNight },
  { id: 'tokyoNightDay', label: 'Tokyo Night Day', dark: false, ext: tokyoNightDay },
  { id: 'materialDark', label: 'Material Dark', dark: true, ext: materialDark },
  { id: 'materialLight', label: 'Material Light', dark: false, ext: materialLight },
  { id: 'gruvboxDark', label: 'Gruvbox Dark', dark: true, ext: gruvboxDark },
  { id: 'gruvboxLight', label: 'Gruvbox Light', dark: false, ext: gruvboxLight },
  { id: 'vscodeDark', label: 'VS Code Dark', dark: true, ext: vscodeDark },
  { id: 'vscodeLight', label: 'VS Code Light', dark: false, ext: vscodeLight },
  { id: 'okaidia', label: 'Okaidia', dark: true, ext: okaidia },
  { id: 'xcodeLight', label: 'Xcode Light', dark: false, ext: xcodeLight },
  { id: 'xcodeDark', label: 'Xcode Dark', dark: true, ext: xcodeDark },
  { id: 'androidstudio', label: 'Android Studio', dark: true, ext: androidstudio },
  { id: 'duotoneDark', label: 'Duotone Dark', dark: true, ext: duotoneDark },
  { id: 'eclipse', label: 'Eclipse', dark: false, ext: eclipse },
  { id: 'sublime', label: 'Sublime', dark: true, ext: sublime },
  { id: 'bespin', label: 'Bespin', dark: true, ext: bespin },
  { id: 'atomone', label: 'Atom One', dark: true, ext: atomone },
  { id: 'aura', label: 'Aura', dark: true, ext: aura },
  { id: 'quietlight', label: 'Quiet Light', dark: false, ext: quietlight },
  { id: 'tomorrowNightBlue', label: 'Tomorrow Night Blue', dark: true, ext: tomorrowNightBlue },
  { id: 'abyss', label: 'Abyss', dark: true, ext: abyss },
];

export const themeById = (id: string): ThemeInfo => THEMES.find((x) => x.id === id) ?? THEMES[0];
