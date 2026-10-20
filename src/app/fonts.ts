import localFont from "next/font/local";

// Jost — the brand's Latin face (OFL). Self-hosted from @fontsource-variable/jost.
// No metric fallback: Arial carries Arabic glyphs and would shadow the Arabic face.
export const jost = localFont({
  src: "../../node_modules/@fontsource-variable/jost/files/jost-latin-wght-normal.woff2",
  weight: "300 600",
  variable: "--font-jost",
  display: "swap",
  adjustFontFallback: false,
});

// Stand-in for Thmanyah Sans until the licensed files are installed (public/fonts/thmanyah).
// Scaled to 115% so Arabic matches the visual height of the neighbouring Latin.
export const arabic = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-300-normal.woff2", weight: "300" },
    { path: "../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2", weight: "400" },
    { path: "../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-500-normal.woff2", weight: "500" },
    { path: "../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-600-normal.woff2", weight: "600" },
    { path: "../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-700-normal.woff2", weight: "700" },
  ],
  variable: "--font-arabic",
  display: "swap",
  adjustFontFallback: false,
  declarations: [{ prop: "size-adjust", value: "115%" }],
});
