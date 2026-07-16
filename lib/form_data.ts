import { GatewayError, invalidRequest } from "./errors.ts";
import { isJsonObject } from "./http.ts";
import type { GatewayConfig, JsonObject } from "./types.ts";

const NUMBER_FIELDS = new Set([
  "n",
  "seconds",
  "num_inference_steps",
  "seed",
]);
const BOOLEAN_FIELDS = new Set(["return_base64"]);
const JSON_FIELDS = new Set(["extra_body", "images"]);

/** Parsed scalar fields and image-like entries from an OpenAI multipart body. */
export interface ParsedMultipartInput {
  fields: JsonObject;
  entries: Map<string, FormDataEntryValue[]>;
}

/** Validate file/count limits and coerce well-known multipart scalar values. */
export function parseFormFields(
  form: FormData,
  config: GatewayConfig,
): ParsedMultipartInput {
  const fields: JsonObject = {};
  const entries = new Map<string, FormDataEntryValue[]>();
  const standardResponseFormatPresent = form.has("response_format");
  let fileCount = 0;

  for (const [name, value] of form.entries()) {
    const values = entries.get(name) ?? [];
    values.push(value);
    entries.set(name, values);

    if (value instanceof File) {
      // Keep the key visible to the compatibility-field collector without
      // serializing the File into the JSON request sent upstream.
      if (!(name in fields)) fields[name] = undefined;
      fileCount += 1;
      if (fileCount > config.maxImageFiles) {
        throw new GatewayError(
          413,
          `Multipart requests support at most ${config.maxImageFiles} files.`,
          { param: name, code: "too_many_files" },
        );
      }
      if (value.size > config.maxFileBytes) {
        throw new GatewayError(
          413,
          `'${name}' exceeds the ${config.maxFileBytes}-byte per-file limit.`,
          { param: name, code: "file_too_large" },
        );
      }
      continue;
    }

    fields[name] = name === "return_base64" &&
        standardResponseFormatPresent
      ? value
      : parseScalar(name, value);
  }

  return { fields, entries };
}

/** Convert a multipart image to a Data URI accepted by Agnes. */
export async function imageEntryToReference(
  value: FormDataEntryValue,
  param: string,
): Promise<string> {
  if (typeof value === "string") {
    if (!value.trim()) {
      throw invalidRequest(`'${param}' cannot be empty.`, param);
    }
    return value;
  }

  if (value.type && !value.type.toLowerCase().startsWith("image/")) {
    throw invalidRequest(`'${param}' must be an image file.`, param);
  }
  const mime = value.type || "application/octet-stream";
  const bytes = new Uint8Array(await value.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Gather edit images from standard multipart `image`/`image[]` fields. */
export async function multipartEditImages(
  parsed: ParsedMultipartInput,
): Promise<string[]> {
  const values = [
    ...(parsed.entries.get("image") ?? []),
    ...(parsed.entries.get("image[]") ?? []),
  ];
  const jsonImages = parsed.fields.images;
  if (Array.isArray(jsonImages)) {
    if (
      jsonImages.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw invalidRequest(
        "'images' must contain image URL or Data URI strings.",
        "images",
      );
    }
    values.push(...jsonImages as string[]);
  }
  if (values.length === 0 && isJsonObject(parsed.fields.extra_body)) {
    const extensionImages = parsed.fields.extra_body.image;
    const extensionValues = Array.isArray(extensionImages)
      ? extensionImages
      : extensionImages === undefined
      ? []
      : [extensionImages];
    if (
      extensionValues.some((value) =>
        typeof value !== "string" || !value.trim()
      )
    ) {
      throw invalidRequest(
        "'extra_body.image' must contain image URL or Data URI strings.",
        "extra_body.image",
      );
    }
    values.push(...extensionValues as string[]);
  }
  return await Promise.all(
    values.map((value, index) =>
      imageEntryToReference(value, `image.${index}`)
    ),
  );
}

export interface MultipartVideoReference {
  reference?: string;
  provided: boolean;
  ignored: Set<string>;
}

/**
 * Obtain a video reference from direct file or SDK-flattened object fields.
 * The official SDK emits `input_reference[image_url]` and `[file_id]`.
 */
export async function multipartVideoReference(
  parsed: ParsedMultipartInput,
): Promise<MultipartVideoReference> {
  const values = parsed.entries.get("input_reference") ?? [];
  if (values.length > 1) {
    throw invalidRequest(
      "Only one 'input_reference' is supported for video generation.",
      "input_reference",
    );
  }
  const nestedUrls = parsed.entries.get("input_reference[image_url]") ?? [];
  const nestedFileIds = parsed.entries.get("input_reference[file_id]") ?? [];
  if (nestedUrls.length > 1 || nestedFileIds.length > 1) {
    throw invalidRequest(
      "Only one video input reference is supported.",
      "input_reference",
    );
  }
  const ignored = new Set<string>();
  if (nestedFileIds.length > 0) ignored.add("input_reference.file_id");

  if (values.length === 1) {
    if (nestedUrls.length > 0) ignored.add("input_reference.image_url");
    return {
      reference: await imageEntryToReference(values[0], "input_reference"),
      provided: true,
      ignored,
    };
  }
  if (nestedUrls.length === 1) {
    const value = nestedUrls[0];
    if (typeof value !== "string" || !value.trim()) {
      throw invalidRequest(
        "'input_reference.image_url' must contain a URL or Data URI.",
        "input_reference.image_url",
      );
    }
    return { reference: value, provided: true, ignored };
  }
  return { provided: nestedFileIds.length > 0, ignored };
}

export interface JsonImageReferences {
  references: string[];
  ignored: Set<string>;
}

/** Normalize image strings/reference objects from JSON edit bodies. */
export function jsonEditImages(input: JsonObject): JsonImageReferences {
  const source = input.images ?? input.image;
  const ignored = new Set<string>();
  if (input.images !== undefined && input.image !== undefined) {
    ignored.add("image");
  }
  if (source === undefined) {
    const extra = isJsonObject(input.extra_body)
      ? input.extra_body.image
      : undefined;
    return {
      references: normalizeStringArray(extra, "extra_body.image"),
      ignored,
    };
  }
  const param = input.images !== undefined ? "images" : "image";
  const values = Array.isArray(source) ? source : [source];
  const references: string[] = [];
  for (const [index, value] of values.entries()) {
    const itemParam = Array.isArray(source) ? `${param}.${index}` : param;
    if (typeof value === "string") {
      if (!value.trim()) {
        throw invalidRequest(`'${itemParam}' cannot be empty.`, itemParam);
      }
      references.push(value);
      continue;
    }
    if (!isJsonObject(value)) {
      throw invalidRequest(
        `'${itemParam}' must be an image URL, Data URI, or reference object.`,
        itemParam,
      );
    }

    for (const key of Object.keys(value)) {
      if (key !== "image_url" && key !== "file_id") {
        ignored.add(`${itemParam}.${key}`);
      }
    }
    if (value.file_id !== undefined) ignored.add(`${itemParam}.file_id`);
    const imageUrl = referenceImageUrl(
      value.image_url,
      `${itemParam}.image_url`,
      ignored,
    );
    if (imageUrl) references.push(imageUrl);
    else if (value.file_id === undefined) {
      throw invalidRequest(
        `'${itemParam}' must contain 'image_url' or 'file_id'.`,
        itemParam,
      );
    }
  }
  return { references, ignored };
}

function normalizeStringArray(value: unknown, param: string): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (
    values.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw invalidRequest(
      `'${param}' must contain image URL or Data URI strings.`,
      param,
    );
  }
  return values as string[];
}

function referenceImageUrl(
  value: unknown,
  param: string,
  ignored: Set<string>,
): string | undefined {
  if (value === undefined) return undefined;
  if (isJsonObject(value)) {
    for (const key of Object.keys(value)) {
      if (key !== "url") ignored.add(`${param}.${key}`);
    }
  }
  const url = typeof value === "string"
    ? value
    : isJsonObject(value) && typeof value.url === "string"
    ? value.url
    : null;
  if (!url?.trim()) {
    throw invalidRequest(`'${param}' must contain a URL or Data URI.`, param);
  }
  return url;
}

function parseScalar(name: string, value: string): unknown {
  if (NUMBER_FIELDS.has(name)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw invalidRequest(`'${name}' must be numeric.`, name);
    }
    return parsed;
  }
  if (BOOLEAN_FIELDS.has(name)) {
    if (value !== "true" && value !== "false") {
      throw invalidRequest(`'${name}' must be true or false.`, name);
    }
    return value === "true";
  }
  if (JSON_FIELDS.has(name)) {
    try {
      return JSON.parse(value);
    } catch {
      throw invalidRequest(`'${name}' must contain valid JSON.`, name);
    }
  }
  return value;
}

/** Browser-compatible base64 encoding without a runtime-specific dependency. */
function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}
