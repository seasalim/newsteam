import fs from "node:fs";
import path from "node:path";

export interface ProviderOption {
  id: "google";
  label: string;
  apiKeyEnv: "GOOGLE_API_KEY";
  apiKeyUrl: string;
}

export interface PersonaOption {
  id: string;
  name: string;
  description: string;
  sourceDir: string;
}

export const DEFAULT_PROVIDER: ProviderOption = {
  id: "google",
  label: "Google Gemini",
  apiKeyEnv: "GOOGLE_API_KEY",
  apiKeyUrl: "https://aistudio.google.com/apikey",
};

export const DEFAULT_PERSONA_ID = "kingclawd";

const PERSONA_ORDER = [
  "kingclawd",
  "the-analyst",
  "machiavelli",
  "the-general",
  "john-bogel",
  "deep-lurker",
] as const;

const REQUIRED_PERSONA_FILES = [
  "IDENTITY.md",
  "INTERESTS.md",
  "LENS.md",
  "feeds.json",
] as const;

function readIdentityField(identity: string, field: string): string | null {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = identity.match(new RegExp(`^\\*\\*${escapedField}:\\*\\*\\s*(.+)$`, "mu"));
  return match?.[1]?.trim() || null;
}

export function loadPersonaCatalog(projectRoot = process.cwd()): PersonaOption[] {
  const personasDir = path.join(projectRoot, "examples", "personas");
  const entries = fs.readdirSync(personasDir, { withFileTypes: true });
  const personas: PersonaOption[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sourceDir = path.join(personasDir, entry.name);
    if (REQUIRED_PERSONA_FILES.some((file) => !fs.existsSync(path.join(sourceDir, file)))) {
      continue;
    }

    const identity = fs.readFileSync(path.join(sourceDir, "IDENTITY.md"), "utf8");
    const name = readIdentityField(identity, "Name");
    const description = readIdentityField(identity, "Creature");
    if (!name || !description) continue;

    personas.push({ id: entry.name, name, description, sourceDir });
  }

  personas.sort((left, right) => {
    const leftIndex = PERSONA_ORDER.indexOf(left.id as typeof PERSONA_ORDER[number]);
    const rightIndex = PERSONA_ORDER.indexOf(right.id as typeof PERSONA_ORDER[number]);
    if (leftIndex >= 0 || rightIndex >= 0) {
      if (leftIndex < 0) return 1;
      if (rightIndex < 0) return -1;
      return leftIndex - rightIndex;
    }
    return left.name.localeCompare(right.name);
  });

  if (personas.length === 0) {
    throw new Error(`No complete example personas found in ${personasDir}`);
  }

  return personas;
}

export function findPersona(
  personas: readonly PersonaOption[],
  value: string,
): PersonaOption | null {
  const normalized = value.trim().toLocaleLowerCase();
  return personas.find((persona) => (
    persona.id.toLocaleLowerCase() === normalized ||
    persona.name.toLocaleLowerCase() === normalized
  )) ?? null;
}

export function resolvePersonaChoice(
  personas: readonly PersonaOption[],
  value: string,
): PersonaOption | null {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return personas.find((persona) => persona.id === DEFAULT_PERSONA_ID) ?? personas[0] ?? null;
  }

  if (/^\d+$/u.test(normalized)) {
    return personas[Number(normalized) - 1] ?? null;
  }

  return findPersona(personas, normalized);
}

export function isConfiguredApiKey(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && normalized !== "your-google-api-key");
}
