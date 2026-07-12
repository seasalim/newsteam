export function stripProviderPrefix(model: string): string {
  return model.replace(/^(?:anthropic|google|openai)\//u, "");
}

export function getModelProvider(model: string): string {
  const match = /^(anthropic|google|openai)\//u.exec(model);
  return match?.[1] ?? "anthropic";
}

export function validateMatchingModelProviders(
  model: string,
  digestModel: string | undefined,
  prefix: string,
): void {
  if (!digestModel) {
    return;
  }

  const modelProvider = getModelProvider(model);
  const digestProvider = getModelProvider(digestModel);

  if (modelProvider !== digestProvider) {
    throw new Error(
      `${prefix}.digest_model must use the same provider as ${prefix}.model`,
    );
  }
}
