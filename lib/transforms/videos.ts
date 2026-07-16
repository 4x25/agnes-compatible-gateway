import { invalidRequest } from "../errors.ts";
import type { JsonObject } from "../types.ts";
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

export interface TransformedVideoRequest {
  body: JsonObject;
  ignored: Set<string>;
}

/** Convert OpenAI video duration/size fields to Agnes frame parameters. */
export function transformVideoRequest(
  input: JsonObject,
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
    model: requireNonEmptyString(input, "model"),
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
