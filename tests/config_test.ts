import { assertEquals, assertThrows } from "@std/assert";
import { buildVideoRequest } from "../gateway/transforms.ts";
import { createAgnesUrls } from "../gateway/upstream.ts";

Deno.test("Agnes URL builder normalizes /v1 and derives sibling /agnesapi", () => {
  const urls = createAgnesUrls("https://agnes.test/nested/v1/");
  assertEquals(urls.baseUrl.toString(), "https://agnes.test/nested/v1");
  assertEquals(
    urls.api("/chat/completions").toString(),
    "https://agnes.test/nested/v1/chat/completions",
  );
  assertEquals(
    urls.videoStatus("video/a b").toString(),
    "https://agnes.test/nested/agnesapi?video_id=video%2Fa+b",
  );
});

Deno.test("Agnes URL builder rejects ambiguous or unsafe base URLs", () => {
  assertThrows(() => createAgnesUrls("ftp://agnes.test/v1"), TypeError);
  assertThrows(() => createAgnesUrls("http://agnes.test/v1"), TypeError);
  assertThrows(() => createAgnesUrls("http://0.0.0.0/v1"), TypeError);
  assertThrows(
    () => createAgnesUrls("https://user:secret@agnes.test/v1"),
    TypeError,
  );
  assertThrows(() => createAgnesUrls("https://@agnes.test/v1"), TypeError);
  assertThrows(() => createAgnesUrls("https://agnes.test/api"), TypeError);
  assertThrows(() => createAgnesUrls("https://agnes.test/v1?q=1"), TypeError);
  assertThrows(
    () => createAgnesUrls("https://agnes.test/v1#fragment"),
    TypeError,
  );
});

Deno.test("Agnes URL builder permits HTTP only for explicit loopback hosts", () => {
  for (
    const baseUrl of [
      "http://localhost:8000/v1",
      "http://127.0.0.1:8000/v1",
      "http://127.42.0.7/v1",
      "http://[::1]:8000/v1",
    ]
  ) {
    assertEquals(createAgnesUrls(baseUrl).baseUrl.toString(), baseUrl);
  }
});

Deno.test("video durations map to the Agnes 8n+1 frame rule", () => {
  for (const [seconds, frames] of [[4, 97], [8, 193], [12, 289]] as const) {
    const result = buildVideoRequest({
      model: "unchanged-model",
      prompt: "prompt",
      seconds,
    });
    if ("error" in result) throw new Error("unexpected validation error");
    assertEquals(result.value.body, {
      model: "unchanged-model",
      prompt: "prompt",
      frame_rate: 24,
      num_frames: frames,
    });
  }
});
