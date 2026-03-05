import keytar from "keytar";

const SERVICE = "do-not-forget";

const PROVIDER_ACCOUNTS: Record<string, string> = {
  aiApiKey:       "openai-api-key",
  openaiApiKey:   "openai-api-key",
  anthropicApiKey:"anthropic-api-key",
  googleApiKey:   "google-api-key",
};

/** Keys that must be stored in the Keychain, never in SQLite. */
export const KEYCHAIN_KEYS = new Set(Object.keys(PROVIDER_ACCOUNTS));

function account(settingsKey: string): string {
  return PROVIDER_ACCOUNTS[settingsKey] ?? settingsKey;
}

export async function keychainSet(key: string, value: string): Promise<void> {
  if (value) {
    await keytar.setPassword(SERVICE, account(key), value);
  } else {
    await keytar.deletePassword(SERVICE, account(key));
  }
}

export async function keychainGet(key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, account(key));
}

export async function keychainDelete(key: string): Promise<void> {
  await keytar.deletePassword(SERVICE, account(key));
}
