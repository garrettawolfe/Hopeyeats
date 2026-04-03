import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ["Georgia", "Cambria", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        cream: "#FAF7F2",
        charcoal: "#1C1C1C",
        gold: "#C9A84C",
        sage: "#6B7C6A",
        ink: "#0a0a0f",
        surface: "#f5f4f1",
        panel: "#ffffff",
        vivid: "#10d974",
        muted: "#6b7280",
      },
    },
  },
  plugins: [],
};
export default config;
