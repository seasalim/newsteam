/**
 * Generic config validation primitives: type guards and require-style
 * field validators that throw with the offending field path.
 *
 * Extracted from config.ts to keep files under 500 lines.
 */

export type ConfigObject = Record<string, unknown>;

export function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, fieldPath: string): ConfigObject {
  if (!isConfigObject(value)) {
    throw new Error(`${fieldPath} is required and must be an object`);
  }

  return value;
}

export function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldPath} is required and must be a non-empty string`);
  }

  return value;
}

export function requirePositiveInteger(value: unknown, fieldPath: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${fieldPath} is required and must be a positive integer`);
  }

  return value as number;
}

export function requireBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldPath} is required and must be a boolean`);
  }

  return value;
}

export function requireIntegerInRange(
  value: unknown,
  fieldPath: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(
      `${fieldPath} is required and must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return value as number;
}

export function validateTimeStrings(times: string[], fieldPath: string): string[] {
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const time of times) {
    if (!timeRegex.test(time)) {
      throw new Error(`${fieldPath} contains invalid time "${time}"; expected HH:MM in 24h format`);
    }
  }
  return times;
}

export function requireEnum(
  value: unknown,
  fieldPath: string,
  validValues: Set<string>,
): string {
  const str = requireString(value, fieldPath);

  if (!validValues.has(str)) {
    const allowed = [...validValues].join(", ");
    throw new Error(`${fieldPath} must be one of: ${allowed}`);
  }

  return str;
}

export function requireStringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldPath} is required and must be an array of strings`);
  }

  return value;
}
