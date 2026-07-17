import { BrandMark } from "./BrandMark.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { COPY, REPOSITORY_URL } from "./content.ts";
import { Icon } from "./Icon.tsx";
import type { Locale } from "./types.ts";

interface SectionsProps {
  locale: Locale;
  copy: typeof COPY[Locale];
}

const DOCKER_SNIPPET = `docker run --rm -p 8000:8000 \\
  -e AGNES_BASE_URL=https://apihub.agnes-ai.com/v1 \\
  ghcr.io/4x25/agnes-compatible-gateway:latest`;

function SectionHeading(
  { eyebrow, title, body, id }: {
    eyebrow: string;
    title: string;
    body?: string;
    id: string;
  },
) {
  return (
    <div class="section-heading split-heading">
      <div>
        <p class="eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      {body && <p>{body}</p>}
    </div>
  );
}

function StatusTag(
  { status, copy }: { status: string; copy: typeof COPY[Locale] },
) {
  const label = status === "pass"
    ? copy.compatibility.pass
    : status === "partial"
    ? copy.compatibility.partial
    : status === "extension"
    ? copy.compatibility.extension
    : copy.compatibility.transform;
  return (
    <span class={`status-tag status-${status}`}>
      <i />
      {label}
    </span>
  );
}

function Compatibility({ copy }: { copy: typeof COPY[Locale] }) {
  const routes = [
    "/v1/chat/completions",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/videos",
    "/v1/videos/{id}",
    "/v1/videos/{id}/content",
  ];
  const rows = copy.compatibility.rows.map((row, index) => ({
    row,
    route: routes[index],
  }));

  return (
    <section
      id="compatibility"
      class="section compatibility-section"
      aria-labelledby="compatibility-title"
    >
      <div class="shell">
        <SectionHeading
          eyebrow={copy.compatibility.eyebrow}
          title={copy.compatibility.title}
          body={copy.compatibility.intro}
          id="compatibility-title"
        />
        <div class="compatibility-table-wrap">
          <table class="compatibility-table">
            <thead>
              <tr>
                <th>{copy.compatibility.capability}</th>
                <th>{copy.compatibility.request}</th>
                <th>{copy.compatibility.mapping}</th>
                <th>{copy.compatibility.status}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, route }) => (
                <tr key={route}>
                  <td>
                    <b>{row[0]}</b>
                    <code>{route}</code>
                  </td>
                  <td>
                    <code>{row[1]}</code>
                  </td>
                  <td>{row[2]}</td>
                  <td>
                    <StatusTag status={row[3]} copy={copy} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="compatibility-cards">
            {rows.map(({ row, route }) => (
              <article key={route}>
                <header>
                  <div>
                    <b>{row[0]}</b>
                    <code>{route}</code>
                  </div>
                  <StatusTag status={row[3]} copy={copy} />
                </header>
                <dl>
                  <div>
                    <dt>{copy.compatibility.request}</dt>
                    <dd>
                      <code>{row[1]}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.compatibility.mapping}</dt>
                    <dd>{row[2]}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Deploy(
  { copy, locale }: { copy: typeof COPY[Locale]; locale: Locale },
) {
  const deploymentGuide = `${REPOSITORY_URL}/blob/master/docs/deployment${
    locale === "zh-CN" ? ".zh-CN" : ""
  }.md`;
  return (
    <section
      id="deploy"
      class="section deploy-section"
      aria-labelledby="deploy-title"
    >
      <div class="shell deploy-grid">
        <div class="deploy-copy">
          <p class="eyebrow">DEPLOY YOUR WAY</p>
          <h2 id="deploy-title">{copy.nav.deploy}</h2>
          <p>{copy.deploy.dockerBody}</p>
          <div class="env-line">
            <span>{copy.deploy.env}</span>
            <code>AGNES_BASE_URL=https://apihub.agnes-ai.com/v1</code>
          </div>
          <a
            href={deploymentGuide}
            target="_blank"
            rel="noreferrer"
          >
            {copy.deploy.deployLink}
            <Icon name="arrow" size={16} />
          </a>
        </div>
        <div class="deploy-options">
          <article>
            <header>
              <span>01</span>
              <Icon name="code" />
            </header>
            <h3>{copy.deploy.docker}</h3>
            <p>{copy.deploy.dockerBody}</p>
            <div class="inline-code">
              <code>{DOCKER_SNIPPET}</code>
              <CopyButton
                value={DOCKER_SNIPPET}
                label={copy.hero.copy}
                copiedLabel={copy.hero.copied}
              />
            </div>
          </article>
          <article>
            <header>
              <span>02</span>
              <Icon name="external" />
            </header>
            <h3>{copy.deploy.deno}</h3>
            <p>{copy.deploy.denoBody}</p>
            <a
              href="https://console.deno.com/"
              target="_blank"
              rel="noreferrer"
            >
              console.deno.com <Icon name="external" size={14} />
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}

function Troubleshooting({ copy }: { copy: typeof COPY[Locale] }) {
  return (
    <section
      class="section troubleshooting-section"
      aria-labelledby="troubleshooting-title"
    >
      <div class="shell">
        <SectionHeading
          eyebrow={copy.troubleshooting.eyebrow}
          title={copy.troubleshooting.title}
          id="troubleshooting-title"
        />
        <div class="accordion-list numbered-accordion">
          {copy.troubleshooting.items.map(([title, body], index) => (
            <details key={title} open={index === 0}>
              <summary>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <b>{title}</b>
                <Icon name="chevron" />
              </summary>
              <p>{body}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq({ copy }: { copy: typeof COPY[Locale] }) {
  return (
    <section id="faq" class="section faq-section" aria-labelledby="faq-title">
      <div class="shell faq-grid">
        <div class="faq-title">
          <p class="eyebrow">{copy.faq.eyebrow}</p>
          <h2 id="faq-title">{copy.faq.title}</h2>
          <span aria-hidden="true">?</span>
        </div>
        <div class="accordion-list">
          {copy.faq.items.map(([question, answer], index) => (
            <details key={question}>
              <summary>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <b>{question}</b>
                <Icon name="chevron" />
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function InformationSections({ locale, copy }: SectionsProps) {
  return (
    <>
      <Compatibility copy={copy} />
      <Deploy copy={copy} locale={locale} />
      <Troubleshooting copy={copy} />
      <Faq copy={copy} />
    </>
  );
}

export function SiteFooter(
  { copy, locale }: { copy: typeof COPY[Locale]; locale: Locale },
) {
  const deploymentGuide = `${REPOSITORY_URL}/blob/master/docs/deployment${
    locale === "zh-CN" ? ".zh-CN" : ""
  }.md`;
  return (
    <footer class="site-footer">
      <div class="shell footer-cta">
        <BrandMark />
        <h2>{copy.footer.title}</h2>
        <a
          class="button button-primary"
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="github" />
          {copy.footer.action}
          <Icon name="arrow" />
        </a>
      </div>
      <div class="shell footer-bottom">
        <a class="brand" href="#top">
          <BrandMark />
          <span>
            AGNES<span>/</span>GATEWAY
          </span>
        </a>
        <p>{copy.footer.independent}</p>
        <nav aria-label="Footer navigation">
          <a href={`${REPOSITORY_URL}/issues`} target="_blank" rel="noreferrer">
            {copy.footer.issue}
          </a>
          <a
            href={deploymentGuide}
            target="_blank"
            rel="noreferrer"
          >
            {copy.footer.docs}
          </a>
          <span>{copy.footer.license}</span>
        </nav>
      </div>
    </footer>
  );
}
