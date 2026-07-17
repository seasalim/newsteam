import {
  DEFAULT_PERSONA_ID,
  DEFAULT_PROVIDER,
  findPersona,
  isConfiguredApiKey,
  loadPersonaCatalog,
  resolvePersonaChoice,
  type PersonaOption,
  type ProviderOption,
} from "./onboarding.ts";
import { createTerminalPrompter, type TerminalPrompter } from "./terminal-prompts.ts";

export interface DemoSetup {
  provider: ProviderOption;
  apiKey: string;
  persona: PersonaOption;
}

export interface DemoSetupOptions {
  env?: NodeJS.ProcessEnv;
  prompter?: TerminalPrompter;
}

function requireDefaultPersona(personas: readonly PersonaOption[]): PersonaOption {
  const persona = findPersona(personas, DEFAULT_PERSONA_ID);
  if (!persona) {
    throw new Error(`Default demo persona "${DEFAULT_PERSONA_ID}" is unavailable`);
  }
  return persona;
}

async function promptForApiKey(prompter: TerminalPrompter): Promise<string> {
  prompter.write(`No ${DEFAULT_PROVIDER.apiKeyEnv} was found.`);
  prompter.write(`Create a free key: ${DEFAULT_PROVIDER.apiKeyUrl}`);

  while (true) {
    const apiKey = (await prompter.secret("Paste your API key: ")).trim();
    if (isConfiguredApiKey(apiKey)) {
      prompter.write("API key: using the entered key for this run only.");
      return apiKey;
    }
    prompter.write("Please enter a non-empty Google API key.");
  }
}

async function promptForPersona(
  personas: readonly PersonaOption[],
  prompter: TerminalPrompter,
): Promise<PersonaOption> {
  prompter.write("");
  prompter.write("Choose your analyst:");
  prompter.write("");
  personas.forEach((persona, index) => {
    prompter.write(`  ${index + 1}. ${persona.name} — ${persona.description}`);
  });
  prompter.write("");

  while (true) {
    const choice = resolvePersonaChoice(personas, await prompter.question("Analyst [1]: "));
    if (choice) return choice;
    prompter.write(`Choose a number from 1 to ${personas.length}.`);
  }
}

export async function collectDemoSetup(
  projectRoot = process.cwd(),
  options: DemoSetupOptions = {},
): Promise<DemoSetup> {
  const env = options.env ?? process.env;
  const prompter = options.prompter ?? createTerminalPrompter();
  const personas = loadPersonaCatalog(projectRoot);
  const configuredApiKey = env[DEFAULT_PROVIDER.apiKeyEnv]?.trim();

  prompter.write(`Provider: ${DEFAULT_PROVIDER.label} (default)`);

  let apiKey: string;
  if (isConfiguredApiKey(configuredApiKey)) {
    apiKey = configuredApiKey!;
    prompter.write(`API key: configured via ${DEFAULT_PROVIDER.apiKeyEnv}`);
  } else if (prompter.interactive) {
    apiKey = await promptForApiKey(prompter);
  } else {
    throw new Error(
      `${DEFAULT_PROVIDER.apiKeyEnv} is required for non-interactive use. Add it to .env and run the demo again.`,
    );
  }

  const personaOverride = env.NEWSTEAM_DEMO_PERSONA?.trim();
  let persona: PersonaOption;
  if (personaOverride) {
    const overriddenPersona = findPersona(personas, personaOverride);
    if (!overriddenPersona) {
      throw new Error(
        `Unknown NEWSTEAM_DEMO_PERSONA "${personaOverride}". Available personas: ${personas.map((entry) => entry.id).join(", ")}`,
      );
    }
    persona = overriddenPersona;
    prompter.write(`Persona: ${persona.name} (${persona.id})`);
  } else if (prompter.interactive) {
    persona = await promptForPersona(personas, prompter);
  } else {
    persona = requireDefaultPersona(personas);
  }

  return { provider: DEFAULT_PROVIDER, apiKey, persona };
}
