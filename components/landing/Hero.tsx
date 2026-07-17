import { useMemo, useState } from "preact/hooks";
import { CopyButton } from "./CopyButton.tsx";
import { DEFAULT_MODELS, ENDPOINTS } from "./content.ts";
import { Icon } from "./Icon.tsx";
import type { Locale, Workflow } from "./types.ts";

interface HeroProps {
  locale: Locale;
  copy: typeof import("./content.ts").COPY[Locale];
  gatewayOrigin: string;
}

type ExampleMode = "curl" | "sdk";

function exampleFor(
  workflow: Workflow,
  mode: ExampleMode,
  gatewayOrigin: string,
) {
  const model = DEFAULT_MODELS[workflow];

  if (mode === "sdk") {
    switch (workflow) {
      case "chat":
        return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${gatewayOrigin}/v1",
  apiKey: process.env.AGNES_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello, Agnes." }],
  stream: true,
});

for await (const part of stream) {
  process.stdout.write(part.choices[0]?.delta?.content ?? "");
}`;
      case "image":
        return `const image = await client.images.generate({
  model: "${model}",
  prompt: "Editorial poster of an orange transit hub",
  size: "1024x1024",
  response_format: "b64_json",
});`;
      case "edit":
        return `import { createReadStream } from "node:fs";

const result = await client.images.edit({
  model: "${model}",
  image: createReadStream("./reference.png"),
  prompt: "Turn the daylight scene into blue hour",
});`;
      case "textVideo":
        return `const video = await client.videos.create({
  model: "${model}",
  prompt: "A paper city unfolding at sunrise",
  seconds: "4",
  size: "720x1280",
});

const done = await client.videos.retrieve(video.id);`;
      case "imageVideo":
        return `const video = await client.videos.create({
  model: "${model}",
  prompt: "Slow camera push through the scene",
  input_reference: await OpenAI.toFile(
    createReadStream("./reference.png"),
  ),
  seconds: "4",
});`;
    }
  }

  switch (workflow) {
    case "chat":
      return `curl ${gatewayOrigin}/v1/chat/completions \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role":"user","content":"Hello, Agnes."}],
    "stream": true
  }'`;
    case "image":
      return `curl ${gatewayOrigin}/v1/images/generations \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "prompt": "Editorial poster of an orange transit hub",
    "size": "1024x1024"
  }'`;
    case "edit":
      return `curl ${gatewayOrigin}/v1/images/edits \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -F "model=${model}" \\
  -F "prompt=Turn the daylight scene into blue hour" \\
  -F "image=@./reference.png"`;
    case "textVideo":
      return `curl ${gatewayOrigin}/v1/videos \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "prompt": "A paper city unfolding at sunrise",
    "seconds": "4",
    "size": "720x1280"
  }'`;
    case "imageVideo":
      return `curl ${gatewayOrigin}/v1/videos \\
  -H "Authorization: Bearer $AGNES_API_KEY" \\
  -F "model=${model}" \\
  -F "prompt=Slow camera push through the scene" \\
  -F "seconds=4" \\
  -F "input_reference=@./reference.png"`;
  }
}

/** Hero code panel is the page's primary visual, using real compatible calls. */
export function Hero({ locale, copy, gatewayOrigin }: HeroProps) {
  const [workflow, setWorkflow] = useState<Workflow>("chat");
  const [mode, setMode] = useState<ExampleMode>("curl");
  const example = useMemo(
    () => exampleFor(workflow, mode, gatewayOrigin),
    [workflow, mode, gatewayOrigin],
  );

  return (
    <section class="hero shell" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">{copy.hero.eyebrow}</p>
        <h1 id="hero-title">
          {copy.hero.titleA}
          <br />
          <span>{copy.hero.titleB}</span>
        </h1>
        <p class="hero-lede">{copy.hero.body}</p>
        <div class="hero-actions">
          <a class="button button-primary" href="#playground">
            {copy.hero.primary}
            <Icon name="arrow" />
          </a>
          <a
            class="button button-secondary"
            href="https://github.com/4x25/agnes-compatible-gateway"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="github" />
            {copy.hero.secondary}
          </a>
        </div>
        <ul class="proof-list" aria-label="Project characteristics">
          {copy.hero.proof.map((item) => (
            <li key={item}>
              <Icon name="check" size={14} />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div class="code-workbench" data-od-id="hero-code-workbench">
        <div class="code-titlebar">
          <span class="window-mark" aria-hidden="true" />
          <span>gateway.request</span>
          <div class="code-mode" role="group" aria-label="Code example type">
            <button
              type="button"
              class={mode === "curl" ? "active" : ""}
              aria-pressed={mode === "curl"}
              onClick={() => setMode("curl")}
            >
              {copy.hero.curl}
            </button>
            <button
              type="button"
              class={mode === "sdk" ? "active" : ""}
              aria-pressed={mode === "sdk"}
              onClick={() => setMode("sdk")}
            >
              {copy.hero.sdk}
            </button>
          </div>
        </div>
        <div
          class="endpoint-tabs endpoint-tabs-dark"
          role="tablist"
          aria-label="Request examples"
        >
          {ENDPOINTS.map((endpoint) => (
            <button
              type="button"
              key={endpoint.id}
              role="tab"
              aria-selected={workflow === endpoint.id}
              class={workflow === endpoint.id ? "active" : ""}
              onClick={() => setWorkflow(endpoint.id)}
            >
              {endpoint.labels[locale]}
            </button>
          ))}
        </div>
        <div class="code-body">
          <CopyButton
            value={example}
            label={copy.hero.copy}
            copiedLabel={copy.hero.copied}
            class="code-copy"
          />
          <pre><code>{example}</code></pre>
        </div>
        <div class="code-statusbar">
          <span>
            <span class="status-dot" /> OpenAI-compatible
          </span>
          <span>
            {ENDPOINTS.find((endpoint) => endpoint.id === workflow)?.path}
          </span>
        </div>
      </div>
    </section>
  );
}
