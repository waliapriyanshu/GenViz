import type { ITheme } from "@visactor/vchart";

/** Neutral graphite series first, then restrained accents. Dark mode leads with the lime highlight. */
const lightPalette = [
  "#1C1C1C",
  "#6FA30C",
  "#0E7490",
  "#B45309",
  "#BE185D",
  "#78716C",
];
const darkPalette = [
  "#C5F135",
  "#5EC4D8",
  "#F0B04A",
  "#F27EA6",
  "#E5E5E0",
  "#8A8A86",
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
  ...chrome("#9A9A96", "#3A3A3A", "#232323"),
};

export const customLightTheme: Partial<ITheme> = {
  type: "light",
  background: "transparent",
  colorScheme: { default: lightPalette },
  ...chrome("#5C5C5C", "#C8C8C4", "#E6E6E2"),
};
