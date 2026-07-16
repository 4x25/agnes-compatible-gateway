import { useMemo, useState } from "preact/hooks";
import { BrandMark } from "./BrandMark.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { COPY, REPOSITORY_URL } from "./content.ts";
import { Icon } from "./Icon.tsx";
import type { Locale } from "./types.ts";

interface SectionsProps {
  locale: Locale;
  copy: typeof COPY[Locale];
}

type CompatibilityFilter = "all" | "text" | "images" | "video";

const SDK_SNIPPET = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://your-gateway.example/v1",
  apiKey: process.env.AGNES_API_KEY,
});

const response = await client.chat.completions.create({
  model: "agnes-2.0-flash", // Passed through unchanged
  messages: [{ role: "user", content: "Hello, Agnes." }],
});

console.log(response.choices[0].message.content);`;

const CURL_SNIPPET = `curl https://your-gateway.example/v1/chat/completions \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role":"user","content":"Hello, Agnes."}]
  }'`;

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
  const [filter, setFilter] = useState<CompatibilityFilter>("all");
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const routes = [
    "/v1/chat/completions",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/videos",
    "/v1/videos/{id}",
    "/v1/videos/{id}/content",
  ];
  const categories: CompatibilityFilter[] = [
    "text",
    "images",
    "images",
    "video",
    "video",
    "video",
  ];
  const rows = useMemo(() =>
    copy.compatibility.rows.map((row, index) => ({
      row,
      route: routes[index],
      category: categories[index],
    })).filter(({ row, category }) => {
      if (filter !== "all" && category !== filter) return false;
      if (onlyDifferences && row[3] === "pass") return false;
      return true;
    }), [copy, filter, onlyDifferences]);

  const filters: [CompatibilityFilter, string][] = [
    ["all", copy.compatibility.all],
    ["text", copy.compatibility.text],
    ["images", copy.compatibility.images],
    ["video", copy.compatibility.video],
  ];

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
        <div class="matrix-controls">
          <div role="group" aria-label="Filter compatibility matrix">
            {filters.map(([value, label]) => (
              <button
                type="button"
                key={value}
                class={filter === value ? "active" : ""}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label class="toggle-field">
            <input
              type="checkbox"
              checked={onlyDifferences}
              onChange={(event) =>
                setOnlyDifferences(event.currentTarget.checked)}
            />
            <span aria-hidden="true" />
            {copy.compatibility.differences}
          </label>
        </div>

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

function Security({ copy }: { copy: typeof COPY[Locale] }) {
  const points = [
    [copy.security.memory, copy.security.memoryBody],
    [copy.security.storage, copy.security.storageBody],
    [copy.security.audit, copy.security.auditBody],
  ];
  return (
    <section class="section security-section" aria-labelledby="security-title">
      <div class="shell">
        <SectionHeading
          eyebrow={copy.security.eyebrow}
          title={copy.security.title}
          id="security-title"
        />
        <div class="request-path" aria-label={copy.security.steps.join(" to ")}>
          {copy.security.steps.map((step, index) => (
            <div key={step}>
              <span>0{index + 1}</span>
              <b>{step}</b>
              {index < copy.security.steps.length - 1 && <Icon name="arrow" />}
            </div>
          ))}
        </div>
        <div class="security-grid">
          <p class="security-statement">{copy.security.body}</p>
          <div class="security-points">
            {points.map(([title, body], index) => (
              <article key={title}>
                <span>0{index + 1}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </article>
            ))}
            <a
              href={`${REPOSITORY_URL}/tree/master/routes`}
              target="_blank"
              rel="noreferrer"
            >
              {copy.security.source}
              <Icon name="external" size={15} />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function QuickStart({ copy }: { copy: typeof COPY[Locale] }) {
  const [sample, setSample] = useState<"sdk" | "curl">("sdk");
  const code = sample === "sdk" ? SDK_SNIPPET : CURL_SNIPPET;
  return (
    <section
      id="quickstart"
      class="section quickstart-section"
      aria-labelledby="quickstart-title"
    >
      <div class="shell">
        <SectionHeading
          eyebrow={copy.quickstart.eyebrow}
          title={copy.quickstart.title}
          body={copy.quickstart.intro}
          id="quickstart-title"
        />
        <div class="quickstart-grid">
          <div class="quickstart-steps">
            <article>
              <span>01</span>
              <div>
                <b>{copy.quickstart.sdk}</b>
                <p>npm install openai</p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <b>baseURL</b>
                <p>https://your-gateway.example/v1</p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <b>apiKey</b>
                <p>process.env.AGNES_API_KEY</p>
              </div>
            </article>
          </div>
          <div class="code-workbench compact-code">
            <div class="code-titlebar">
              <span class="window-mark" aria-hidden="true" />
              <span>quickstart.ts</span>
              <div
                class="code-mode"
                role="group"
                aria-label="Quick start language"
              >
                <button
                  type="button"
                  class={sample === "sdk" ? "active" : ""}
                  onClick={() => setSample("sdk")}
                >
                  {copy.quickstart.sdk}
                </button>
                <button
                  type="button"
                  class={sample === "curl" ? "active" : ""}
                  onClick={() => setSample("curl")}
                >
                  {copy.quickstart.curl}
                </button>
              </div>
            </div>
            <div class="code-body">
              <CopyButton
                value={code}
                label={copy.hero.copy}
                copiedLabel={copy.hero.copied}
                class="code-copy"
              />
              <pre><code>{code}</code></pre>
            </div>
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
          <p>{copy.quickstart.dockerBody}</p>
          <div class="env-line">
            <span>{copy.quickstart.env}</span>
            <code>AGNES_BASE_URL=https://apihub.agnes-ai.com/v1</code>
          </div>
          <a
            href={deploymentGuide}
            target="_blank"
            rel="noreferrer"
          >
            {copy.quickstart.deployLink}
            <Icon name="arrow" size={16} />
          </a>
        </div>
        <div class="deploy-options">
          <article>
            <header>
              <span>01</span>
              <Icon name="code" />
            </header>
            <h3>{copy.quickstart.docker}</h3>
            <p>{copy.quickstart.dockerBody}</p>
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
            <h3>{copy.quickstart.deno}</h3>
            <p>{copy.quickstart.denoBody}</p>
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
      <Security copy={copy} />
      <QuickStart copy={copy} />
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
