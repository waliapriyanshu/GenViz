import type { ITheme } from "@visactor/vchart";

/** Muted, print-style categorical palette; the first color is the brand accent. */
const lightPalette = [
  "#B54012",
  "#2F6F8F",
  "#6B7F3A",
  "#B8860B",
  "#7A4F7D",
  "#57534E",
];
const darkPalette = [
  "#EE652B",
  "#5DA9C9",
  "#A3B86A",
  "#E0B341",
  "#B88BC0",
  "#A8A29E",
];

const chrome = (text: string, line: string, grid: string) =>
  ({
    component: {
      axis: {
        domainLine: { style: { stroke: line } },
        tick: { style: { stroke: line } },
        grid: { style: { stroke: grid, lineDash: [] } },
        label: { style: { fill: text, fontSize: 12 } },
        title: { style: { fill: text, fontSize: 12 } },
      },
      discreteLegend: {
        item: { label: { style: { fill: text, fontSize: 12 } } },
      },
    },
  }) as Partial<ITheme>;

export const customDarkTheme: Partial<ITheme> = {
  type: "dark",
  background: "transparent",
  colorScheme: { default: darkPalette },
  ...chrome("#A39E97", "#3A3733", "#2A2825"),
};

export const customLightTheme: Partial<ITheme> = {
  type: "light",
  background: "transparent",
  colorScheme: { default: lightPalette },
  ...chrome("#6B655F", "#CFC9BF", "#E6E1D8"),
};
