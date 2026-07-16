import { invalidRequest } from "../errors.ts";
import { isJsonObject } from "../http.ts";
import type { JsonObject } from "../types.ts";

export function requireNonEmptyString(
  input: JsonObject,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`'${name}' must be a non-empty string.`, name);
  }
  return value;
}

export function optionalString(
  input: JsonObject,
  name: string,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`'${name}' must be a non-empty string.`, name);
  }
  return value;
}

export function optionalBoolean(
  input: JsonObject,
  name: string,
): boolean | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalidRequest(`'${name}' must be a boolean.`, name);
  }
  return value;
}

export function optionalFiniteNumber(
  input: JsonObject,
  name: string,
): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidRequest(`'${name}' must be a finite number.`, name);
  }
  return value;
}

export function optionalInteger(
  input: JsonObject,
  name: string,
): number | undefined {
  const value = optionalFiniteNumber(input, name);
  if (value !== undefined && !Number.isInteger(value)) {
    throw invalidRequest(`'${name}' must be an integer.`, name);
  }
  return value;
}

export function optionalObject(
  input: JsonObject,
  name: string,
): JsonObject | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw invalidRequest(`'${name}' must be an object.`, name);
  }
  return value;
}

export function collectUnknownFields(
  input: JsonObject,
  supported: ReadonlySet<string>,
): Set<string> {
  return new Set(Object.keys(input).filter((name) => !supported.has(name)));
}
