import { invalidRequest } from "../errors.ts";
import type { JsonObject } from "../types.ts";
import { isJsonObject } from "../http.ts";
import {
  collectUnknownFields,
  optionalInteger,
  optionalObject,
  optionalString,
  requireNonEmptyString,
} from "./shared.ts";

const VIDEO_FIELDS = new Set([
  "model",
  "prompt",
  "seconds",
  "size",
  "input_reference",
  "input_reference[image_url]",
  "input_reference[file_id]",
  // Agnes extensions accepted for advanced workflows.
  "image",
  "mode",
  "height",
  "width",
  "num_frames",
  "frame_rate",
  "num_inference_steps",
  "seed",
  "negative_prompt",
  "extra_body",
]);

const OPENAI_VIDEO_SECONDS = new Set([4, 8, 12]);
const OPENAI_VIDEO_SIZES = new Set([
  "720x1280",
  "1280x720",
  "1024x1792",
  "1792x1024",
]);

/**
 * Agnes Video 2.5/2.5 Flash replaces the V2.0 frame/size controls with
 * seconds, a size tier, an aspect ratio, and an explicit mode plus named
 * media fields. Keep the two dialects separate so existing V2.0 callers are
 * unaffected.
 */
const VIDEO_25_FIELDS = new Set([
  "model",
  "prompt",
  "seconds",
  "size",
  "aspect_ratio",
  "mode",
  "seed",
  "input_reference",
  "input_reference[image_url]",
  "input_reference[file_id]",
  "first_frame",
  "last_frame",
  "images",
  "audios",
  "videos",
  "extra_body",
]);

// V2.0-only tuning fields have no documented 2.5 equivalent.
const VIDEO_25_LEGACY_FIELDS = [
  "num_frames",
  "frame_rate",
  "width",
  "height",
  "num_inference_steps",
  "negative_prompt",
];

const VIDEO_25_TIERS = new Set(["720P", "1080P", "1K", "2K"]);
const VIDEO_25_RATIOS = new Set([
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);

// Standard OpenAI video sizes map onto a 2.5 size tier and aspect ratio.
// Omitting `size` keeps the OpenAI portrait default (720x1280 -> 9:16) that
// the V2.0 dialect also produces, while an explicit tier defaults to the
// documented 16:9 ratio.
const VIDEO_25_PIXEL_SIZES: Record<string, { tier: string; ratio: string }> = {
  "720x1280": { tier: "720P", ratio: "9:16" },
  "1280x720": { tier: "720P", ratio: "16:9" },
  "1024x1792": { tier: "720P", ratio: "9:16" },
  "1792x1024": { tier: "720P", ratio: "16:9" },
};

const VIDEO_25_MODEL = /^agnes-video-2\.5(?=$|[-._])/i;
const VIDEO_25_FLASH_MODEL = /^agnes-video-2\.5-flash$/i;
const VIDEO_25_MODE_ALIASES: Record<string, string> = {
  keyframes: "keyframe",
  ti2vid: "keyframe",
  i2vid: "keyframe",
  multi_reference: "reference",
};

/**
 * Agnes Video 2.5 and 2.5 Flash share one request/response contract that is
 * incompatible with the V2.0 frame-based dialect and requires querying with an
 * exact `model_name`. Both the transform and the stateless retrieval path must
 * agree on this family test.
 */
export function isAgnesVideo25Model(model: string): boolean {
  return VIDEO_25_MODEL.test(model);
}

export interface TransformedVideoRequest {
  body: JsonObject;
  ignored: Set<string>;
}

/**
 * Convert an OpenAI Videos create body to the dialect used by the requested
 * Agnes model family. Video 2.5 and 2.5 Flash use seconds/size/ratio/mode;
 * every other model keeps the V2.0 frame/size contract unchanged.
 */
export function transformVideoRequest(
  input: JsonObject,
  inputReference?: string,
  multipartReferenceProvided = false,
): TransformedVideoRequest {
  const model = requireNonEmptyString(input, "model");
  return isAgnesVideo25Model(model)
    ? transformVideo25Request(
      input,
      model,
      inputReference,
      multipartReferenceProvided,
    )
    : transformVideoV20Request(
      input,
      model,
      inputReference,
      multipartReferenceProvided,
    );
}

/** Convert OpenAI video duration/size fields to Agnes V2.0 frame parameters. */
function transformVideoV20Request(
  input: JsonObject,
  model: string,
  inputReference?: string,
  multipartReferenceProvided = false,
): TransformedVideoRequest {
  const ignored = collectUnknownFields(input, VIDEO_FIELDS);
  if (!multipartReferenceProvided) {
    for (
      const field of [
        "input_reference[image_url]",
        "input_reference[file_id]",
      ]
    ) {
      if (input[field] !== undefined) ignored.add(field);
    }
  }
  const body: JsonObject = {
    model,
    prompt: requireNonEmptyString(input, "prompt"),
  };

  const seconds = parseSeconds(input.seconds ?? 4);
  const { width, height } = parseSize(input.size ?? "720x1280");

  // 24 fps yields 8n+1 frame counts for integer durations, satisfying the
  // upstream model's frame constraint. Agnes caps jobs at 441 frames.
  const numFrames = seconds * 24 + 1;
  if (numFrames > 441) {
    throw invalidRequest(
      "'seconds' exceeds the Agnes maximum of 18 seconds at 24 fps.",
      "seconds",
    );
  }
  body.num_frames = numFrames;
  body.frame_rate = 24;
  body.width = width;
  body.height = height;

  for (const conflict of ["num_frames", "frame_rate", "width", "height"]) {
    if (input[conflict] !== undefined) ignored.add(conflict);
  }

  for (const name of ["num_inference_steps", "seed"] as const) {
    const value = optionalInteger(input, name);
    if (value !== undefined) body[name] = value;
  }
  for (const name of ["mode", "negative_prompt"] as const) {
    const value = optionalString(input, name);
    if (value !== undefined) body[name] = value;
  }
  const extraBody = optionalObject(input, "extra_body");
  const copiedExtraBody = extraBody === undefined
    ? undefined
    : { ...extraBody };

  const standardReferenceProvided = multipartReferenceProvided ||
    inputReference !== undefined ||
    input.input_reference !== undefined;
  const standardReference = inputReference ??
    parseReference(input.input_reference, ignored);
  if (standardReferenceProvided) {
    if (input.image !== undefined) ignored.add("image");
    if (copiedExtraBody?.image !== undefined) {
      ignored.add("extra_body.image");
      delete copiedExtraBody.image;
    }
    if (standardReference !== undefined) body.image = standardReference;
  } else {
    const agnesImage = optionalString(input, "image");
    if (agnesImage !== undefined) body.image = agnesImage;
  }

  if (copiedExtraBody && Object.keys(copiedExtraBody).length > 0) {
    body.extra_body = copiedExtraBody;
  }

  return { body, ignored };
}

/**
 * Convert one request to the Agnes Video 2.5/2.5 Flash contract.
 *
 * Recognized `extra_body` members are hoisted to the top level because the
 * 2.5 dialect documents `mode`, `aspect_ratio`, and media fields at the top
 * level. Top-level values always win, and every overridden or unknown path is
 * reported in the ignored-params header instead of silently forwarded.
 */
function transformVideo25Request(
  input: JsonObject,
  model: string,
  inputReference: string | undefined,
  multipartReferenceProvided: boolean,
): TransformedVideoRequest {
  const ignored = collectUnknownFields(input, VIDEO_25_FIELDS);
  for (const field of VIDEO_25_LEGACY_FIELDS) {
    if (input[field] !== undefined) ignored.add(field);
  }

  const source: JsonObject = { ...input };
  const extraBody = optionalObject(input, "extra_body");
  if (extraBody) {
    for (const [name, value] of Object.entries(extraBody)) {
      if (
        name === "model" || name === "prompt" || name === "extra_body" ||
        !VIDEO_25_FIELDS.has(name)
      ) {
        ignored.add(`extra_body.${name}`);
        continue;
      }
      if (source[name] !== undefined) {
        ignored.add(`extra_body.${name}`);
        continue;
      }
      source[name] = value;
    }
  }

  const body: JsonObject = {
    model,
    prompt: requireNonEmptyString(input, "prompt"),
    seconds: parseVideo25Seconds(source.seconds),
  };

  const explicitRatio = optionalString(source, "aspect_ratio");
  if (explicitRatio !== undefined && !VIDEO_25_RATIOS.has(explicitRatio)) {
    throw invalidRequest(
      `'aspect_ratio' must be one of ${[...VIDEO_25_RATIOS].join(", ")}.`,
      "aspect_ratio",
    );
  }
  const explicitSize = optionalString(source, "size");
  let size: string;
  let ratio: string;
  if (explicitSize === undefined) {
    size = "720P";
    ratio = explicitRatio ?? VIDEO_25_PIXEL_SIZES["720x1280"].ratio;
  } else if (VIDEO_25_TIERS.has(explicitSize)) {
    size = explicitSize;
    ratio = explicitRatio ?? "16:9";
  } else {
    const mapped = VIDEO_25_PIXEL_SIZES[explicitSize];
    if (mapped === undefined) {
      throw invalidRequest(
        "'size' must be 720P, 1080P, 1K, 2K, or one of 720x1280, 1280x720, 1024x1792, 1792x1024.",
        "size",
      );
    }
    size = mapped.tier;
    ratio = mapped.ratio;
    if (explicitRatio !== undefined && explicitRatio !== mapped.ratio) {
      ignored.add("aspect_ratio");
    }
  }
  body.size = size;
  body.aspect_ratio = ratio;

  if (!multipartReferenceProvided) {
    for (
      const field of [
        "input_reference[image_url]",
        "input_reference[file_id]",
      ]
    ) {
      if (input[field] !== undefined) ignored.add(field);
    }
  }
  const standardReferenceProvided = multipartReferenceProvided ||
    inputReference !== undefined ||
    source.input_reference !== undefined;
  const standardReference = inputReference ??
    parseReference(source.input_reference, ignored);
  const extensionImage = optionalString(source, "image");
  const explicitFirstFrame = optionalString(source, "first_frame");
  const lastFrame = optionalString(source, "last_frame");
  let firstFrame: string | undefined;
  if (standardReferenceProvided) {
    if (explicitFirstFrame !== undefined) ignored.add("first_frame");
    if (extensionImage !== undefined) ignored.add("image");
    firstFrame = standardReference;
  } else if (explicitFirstFrame !== undefined) {
    if (extensionImage !== undefined) ignored.add("image");
    firstFrame = explicitFirstFrame;
  } else if (extensionImage !== undefined) {
    firstFrame = extensionImage;
  }

  const images = stringArray(source.images, "images");
  const audios = stringArray(source.audios, "audios");
  const videos = videoReferenceArray(source.videos);
  if (VIDEO_25_FLASH_MODEL.test(model)) {
    if (size !== "720P") {
      throw invalidRequest(
        "'size' must be 720P for agnes-video-2.5-flash.",
        "size",
      );
    }
    if (images.length > 5) {
      throw invalidRequest(
        "'images' supports at most 5 references for agnes-video-2.5-flash.",
        "images",
      );
    }
    if (audios.length > 3) {
      throw invalidRequest(
        "'audios' supports at most 3 references for agnes-video-2.5-flash.",
        "audios",
      );
    }
    if (videos.length > 0) {
      throw invalidRequest(
        "'videos' is not supported for agnes-video-2.5-flash.",
        "videos",
      );
    }
  }

  body.mode = resolveVideo25Mode(
    optionalString(source, "mode"),
    firstFrame !== undefined || lastFrame !== undefined,
    images.length > 0 || audios.length > 0 || videos.length > 0,
  );
  if (firstFrame !== undefined) body.first_frame = firstFrame;
  if (lastFrame !== undefined) body.last_frame = lastFrame;
  if (images.length > 0) body.images = images;
  if (audios.length > 0) body.audios = audios;
  if (videos.length > 0) body.videos = videos;

  const seed = optionalInteger(source, "seed");
  if (seed !== undefined) body.seed = seed;

  return { body, ignored };
}

function parseVideo25Seconds(value: unknown): string {
  const number = typeof value === "string" && value.trim()
    ? Number(value)
    : value ?? 4;
  if (
    typeof number !== "number" || !Number.isInteger(number) ||
    number < 4 || number > 12
  ) {
    throw invalidRequest(
      "'seconds' must be an integer from 4 to 12.",
      "seconds",
    );
  }
  return String(number);
}

function resolveVideo25Mode(
  explicit: string | undefined,
  hasKeyframeMedia: boolean,
  hasReferenceMedia: boolean,
): string {
  if (explicit !== undefined) {
    return VIDEO_25_MODE_ALIASES[explicit.toLowerCase()] ??
      explicit.toLowerCase();
  }
  if (hasKeyframeMedia && hasReferenceMedia) {
    throw invalidRequest(
      "'mode' is required when a request mixes keyframe and reference media.",
      "mode",
    );
  }
  if (hasKeyframeMedia) return "keyframe";
  return hasReferenceMedia ? "reference" : "text";
}

function stringArray(value: unknown, param: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidRequest(`'${param}' must be an array.`, param);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw invalidRequest(
        `'${param}.${index}' must be a non-empty string.`,
        `${param}.${index}`,
      );
    }
    return item;
  });
}

function videoReferenceArray(value: unknown): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidRequest("'videos' must be an array.", "videos");
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw invalidRequest(
        `'videos.${index}' must be an object.`,
        `videos.${index}`,
      );
    }
    return { ...item };
  });
}

function parseSeconds(value: unknown): number {
  const number = typeof value === "string" && value.trim()
    ? Number(value)
    : value;
  if (typeof number !== "number" || !OPENAI_VIDEO_SECONDS.has(number)) {
    throw invalidRequest(
      "'seconds' must be one of 4, 8, or 12.",
      "seconds",
    );
  }
  return number;
}

function parseSize(value: unknown): { width: number; height: number } {
  if (typeof value !== "string") {
    throw invalidRequest("'size' must use the WIDTHxHEIGHT format.", "size");
  }
  if (!OPENAI_VIDEO_SIZES.has(value.trim())) {
    throw invalidRequest(
      "'size' must be one of 720x1280, 1280x720, 1024x1792, or 1792x1024.",
      "size",
    );
  }
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value.trim());
  if (!match) {
    throw invalidRequest("'size' must use the WIDTHxHEIGHT format.", "size");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw invalidRequest(
      "'size' dimensions must be greater than zero.",
      "size",
    );
  }
  return { width, height };
}

function parseReference(
  value: unknown,
  ignored: Set<string>,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const reference = value as JsonObject;
    for (const key of Object.keys(reference)) {
      if (key !== "image_url" && key !== "file_id") {
        ignored.add(`input_reference.${key}`);
      }
    }
    if (reference.file_id !== undefined) {
      ignored.add("input_reference.file_id");
    }
    const candidate = reference.image_url;
    if (
      typeof candidate === "object" && candidate !== null &&
      !Array.isArray(candidate)
    ) {
      for (const key of Object.keys(candidate as JsonObject)) {
        if (key !== "url") {
          ignored.add(`input_reference.image_url.${key}`);
        }
      }
    }
    const url = typeof candidate === "string"
      ? candidate
      : typeof candidate === "object" && candidate !== null &&
          !Array.isArray(candidate) &&
          typeof (candidate as JsonObject).url === "string"
      ? (candidate as JsonObject).url as string
      : undefined;
    if (url?.trim()) return url;
    if (candidate !== undefined) {
      throw invalidRequest(
        "'input_reference.image_url' must contain a URL or Data URI.",
        "input_reference.image_url",
      );
    }
    if (reference.file_id !== undefined) return undefined;
  }
  throw invalidRequest(
    "'input_reference' must be an image URL, reference object, or multipart file.",
    "input_reference",
  );
}
