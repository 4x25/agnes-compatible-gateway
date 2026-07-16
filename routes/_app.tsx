import { define } from "../utils.ts";

const themeBootstrap = `(() => {
  try {
    const stored = localStorage.getItem("agnes-gateway.theme");
    const theme = stored === "dark" || stored === "light"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
})();`;

export default define.page(function App({ Component }) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script>{themeBootstrap}</script>
      </head>
      <body>
        <Component />
      </body>
    </html>
  );
});
