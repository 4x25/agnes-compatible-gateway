import { invalidRequest } from "../errors.ts";
import type { JsonObject } from "../types.ts";
import {
  collectUnknownFields,
  optionalBoolean,
  optionalInteger,
  optionalObject,
  optionalString,
  requireNonEmptyString,
} from "./shared.ts";

const IMAGE_FIELDS = new Set([
  "model",
  "prompt",
  "size",
  "n",
  "response_format",
  "ratio",
  "return_base64",
  "extra_body",
  // Consumed by the edits adapter rather than sent as top-level Agnes fields.
  "image",
  "image[]",
  "images",
]);

export type ImageOperation = "generation" | "edit";

export interface TransformedImageRequest {
  body: JsonObject;
  ignored: Set<string>;
  n: number;
}

/** Convert image generation/edit fields and resolve standard-vs-extension precedence. */
export function transformImageRequest(
  input: JsonObject,
  operation: ImageOperation,
  editImages: string[] = [],
  standardEditImagesProvided = false,
): TransformedImageRequest {
  const ignored = collectUnknownFields(input, IMAGE_FIELDS);
  if (operation === "generation") {
    for (const field of ["image", "image[]", "images"]) {
      if (input[field] !== undefined) ignored.add(field);
    }
  }
  const size = optionalString(input, "size") ?? "1024x1024";
  const body: JsonObject = {
    model: requireNonEmptyString(input, "model"),
    prompt: requireNonEmptyString(input, "prompt"),
    size,
  };

  const ratio = optionalString(input, "ratio");
  if (ratio !== undefined) body.ratio = ratio;

  const responseFormat = optionalString(input, "response_format");
  if (
    responseFormat !== undefined && responseFormat !== "url" &&
    responseFormat !== "b64_json"
  ) {
    throw invalidRequest(
      "'response_format' must be 'url' or 'b64_json'.",
      "response_format",
    );
  }
  // Do not validate an Agnes extension that the standard OpenAI field
  // overrides. This lets a valid portable request continue while still
  // reporting the removed conflict.
  const returnBase64 = responseFormat === undefined
    ? optionalBoolean(input, "return_base64")
    : undefined;
  if (returnBase64 !== undefined) body.return_base64 = returnBase64;

  const sourceExtra = optionalObject(input, "extra_body");
  const extraBody: JsonObject = sourceExtra ? { ...sourceExtra } : {};

  if (operation === "edit") {
    if (editImages.length === 0) {
      throw invalidRequest(
        "At least one input image is required for an image edit.",
        "image",
      );
    }
    if (extraBody.image !== undefined && standardEditImagesProvided) {
      ignored.add("extra_body.image");
    }
    extraBody.image = editImages;
  }

  if (responseFormat !== undefined) {
    // The standard OpenAI field wins over the Agnes top-level extension. Drop
    // the extension even when both values happen to agree so the upstream
    // receives one unambiguous representation of the requested format.
    if (input.return_base64 !== undefined) {
      ignored.add("return_base64");
      delete body.return_base64;
    }
    if (extraBody.response_format !== undefined) {
      ignored.add("extra_body.response_format");
    }
    if (operation === "generation" && responseFormat === "b64_json") {
      body.return_base64 = true;
      delete extraBody.response_format;
    } else {
      extraBody.response_format = responseFormat;
    }
  }

  if (Object.keys(extraBody).length > 0) body.extra_body = extraBody;

  const n = optionalInteger(input, "n") ?? 1;
  if (n < 1 || n > 10) {
    throw invalidRequest("'n' must be an integer from 1 to 10.", "n");
  }

  return { body, ignored, n };
}
