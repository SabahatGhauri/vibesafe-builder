"use strict";
/* Curated color palettes a customer can pick before (or during) building an
   app, so the AI has something concrete to anchor its design on instead of
   picking its own every time. Presets only here, deliberately — a hand-picked
   set guarantees every option actually looks good; a fully custom picker is
   offered separately in the composer, for someone with brand colors already
   in mind, alongside these. Purely static client-side data, same pattern as
   templates.js: the server never needs to know palette names or ids, only the
   four hex values a chosen palette resolves to (see lib/palette.js). */

window.PALETTES = [
  {
    id: "midnight-teal",
    name: "Midnight Teal",
    colors: { bg: "#0f2c2b", primary: "#1f6f6a", accent: "#3fd6c4", text: "#eef7f6" },
  },
  {
    id: "sunset-coral",
    name: "Sunset Coral",
    colors: { bg: "#3b1f1a", primary: "#d9542f", accent: "#f7b267", text: "#fff4e6" },
  },
  {
    id: "electric-violet",
    name: "Electric Violet",
    colors: { bg: "#2b2438", primary: "#6f4fd6", accent: "#a78bfa", text: "#f5f2ff" },
  },
  {
    id: "forest-sage",
    name: "Forest Sage",
    colors: { bg: "#1a2e23", primary: "#4d7c5f", accent: "#9cbfa3", text: "#f1f5f0" },
  },
  {
    id: "warm-neutral",
    name: "Warm Neutral",
    colors: { bg: "#221c16", primary: "#a9754f", accent: "#e3c39d", text: "#f7f0e6" },
  },
  {
    id: "ocean-blue",
    name: "Ocean Blue",
    colors: { bg: "#0c1f33", primary: "#2f6fb3", accent: "#6fc3e6", text: "#eaf5fb" },
  },
  {
    id: "crimson-ember",
    name: "Crimson Ember",
    colors: { bg: "#1c0e0e", primary: "#b3242b", accent: "#ff6b57", text: "#fbe9e7" },
  },
  {
    id: "golden-hour",
    name: "Golden Hour",
    colors: { bg: "#241c0b", primary: "#c98d1f", accent: "#ffd166", text: "#fff8e6" },
  },
  {
    id: "slate-mono",
    name: "Slate Mono",
    colors: { bg: "#17191c", primary: "#4b5259", accent: "#c7ccd1", text: "#f2f3f4" },
  },
  {
    id: "rose-quartz",
    name: "Rose Quartz",
    colors: { bg: "#2b1a20", primary: "#c9587a", accent: "#f5a9c0", text: "#fdeef2" },
  },
];
