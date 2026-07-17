import { useEffect, useState } from "preact/hooks";
import { BrandMark } from "../components/landing/BrandMark.tsx";
import { COPY, REPOSITORY_URL } from "../components/landing/content.ts";
import { Hero } from "../components/landing/Hero.tsx";
import { Icon } from "../components/landing/Icon.tsx";
import { Playground } from "../components/landing/Playground.tsx";
import {
  InformationSections,
  SiteFooter,
} from "../components/landing/Sections.tsx";
import type { Locale } from "../components/landing/types.ts";

type Theme = "light" | "dark";

interface GatewayLandingProps {
  /** Request origin rendered by Fresh, including protocol and optional port. */
  gatewayOrigin: string;
}

export default function GatewayLanding({ gatewayOrigin }: GatewayLandingProps) {
  const [locale, setLocale] = useState<Locale>("en");
  const [theme, setTheme] = useState<Theme>("light");
  const [menuOpen, setMenuOpen] = useState(false);
  const copy = COPY[locale];

  useEffect(() => {
    const storedLocale = localStorage.getItem("agnes-gateway.locale");
    const inferred = navigator.language.toLowerCase().startsWith("zh")
      ? "zh-CN"
      : "en";
    setLocale(
      storedLocale === "en" || storedLocale === "zh-CN"
        ? storedLocale
        : inferred,
    );

    const applied = document.documentElement.dataset.theme;
    setTheme(applied === "dark" ? "dark" : "light");
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh-CN" ? "zh-Hans" : "en";
    localStorage.setItem("agnes-gateway.locale", locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("agnes-gateway.theme", theme);
  }, [theme]);

  function jumpTo(hash: string) {
    setMenuOpen(false);
    // Assigning the hash preserves native reduced-motion and focus behavior.
    globalThis.location.hash = hash;
  }

  const navItems = [
    ["playground", copy.nav.playground],
    ["compatibility", copy.nav.compatibility],
    ["deploy", copy.nav.deploy],
    ["faq", copy.nav.faq],
  ] as const;

  return (
    <div class="site-frame">
      <a class="skip-link" href="#main">{copy.skip}</a>
      <header class="site-header">
        <div class="shell header-inner">
          <a
            class="brand"
            href="#top"
            aria-label="Agnes Compatible Gateway home"
          >
            <BrandMark />
            <span>
              AGNES<span>/</span>GATEWAY
            </span>
          </a>

          <nav class="desktop-nav" aria-label="Primary navigation">
            {navItems.map(([hash, label]) => (
              <a key={hash} href={`#${hash}`}>{label}</a>
            ))}
          </nav>

          <div class="header-actions">
            <a
              class="github-chip"
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={copy.nav.github}
            >
              <Icon name="github" size={17} />
              <span class="github-label">GitHub</span>
            </a>
            <button
              class="icon-button"
              type="button"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              aria-label={copy.nav.theme}
            >
              <Icon name={theme === "light" ? "moon" : "sun"} />
            </button>
            <button
              class="locale-button"
              type="button"
              onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}
              aria-label={copy.nav.locale}
            >
              {locale === "en" ? "中文" : "EN"}
            </button>
            <button
              class="icon-button menu-button"
              type="button"
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              aria-label={menuOpen ? copy.nav.close : copy.nav.menu}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon name={menuOpen ? "close" : "menu"} />
            </button>
          </div>
        </div>
        <nav
          id="mobile-navigation"
          class={`mobile-nav ${menuOpen ? "open" : ""}`}
          aria-label="Mobile navigation"
          hidden={!menuOpen}
        >
          {navItems.map(([hash, label], index) => (
            <button
              type="button"
              key={hash}
              onClick={() => jumpTo(hash)}
            >
              <span>0{index + 1}</span>
              {label}
              <Icon name="arrow" />
            </button>
          ))}
        </nav>
      </header>

      <main id="main">
        <div id="top" class="anchor-target" />
        <Hero locale={locale} copy={copy} gatewayOrigin={gatewayOrigin} />
        <Playground
          locale={locale}
          copy={copy}
          gatewayOrigin={gatewayOrigin}
        />
        <InformationSections locale={locale} copy={copy} />
      </main>
      <SiteFooter copy={copy} locale={locale} />
    </div>
  );
}
