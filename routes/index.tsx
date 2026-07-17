import { Head } from "fresh/runtime";
import GatewayLanding from "../islands/GatewayLanding.tsx";
import { define } from "../utils.ts";

export default define.page(function Home({ url }) {
  return (
    <>
      <Head>
        <title>Agnes Compatible Gateway — OpenAI-compatible API</title>
        <meta
          name="description"
          content="A lightweight, open-source gateway that exposes Agnes AI chat, image, image editing, and video generation through OpenAI-compatible APIs."
        />
        <meta
          name="theme-color"
          content="#fafafa"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#151515"
          media="(prefers-color-scheme: dark)"
        />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Agnes OpenAI Compatible Gateway" />
        <meta
          property="og:description"
          content="Bring Agnes AI chat, image, and video generation to the OpenAI tools you already use."
        />
        <link rel="icon" type="image/svg+xml" href="/brand-mark.svg" />
      </Head>
      <GatewayLanding gatewayOrigin={url.origin} />
    </>
  );
});
