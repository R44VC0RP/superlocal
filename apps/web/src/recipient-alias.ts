type RecipientSummary = {
  folder: string;
  to: readonly { email: string }[];
  cc: readonly { email: string }[];
  deliveredTo?: readonly string[];
};

type RecipientIdentity = {
  email: string;
  isPrimary: boolean;
};

const nonIncomingFolders = new Set(["sent", "draft", "drafts", "scheduled", "outbox", "unsent", "queued"]);

export const isIncomingRecipientFolder = (folder: string): boolean => !nonIncomingFolders.has(folder.toLowerCase());

/** Header recipients from drafts, sends and queued sends are not evidence of incoming delivery. */
export function hasIncomingRecipientHeaders(messages: readonly RecipientSummary[]): boolean {
  return messages.some((message) => isIncomingRecipientFolder(message.folder)
    && (message.to.length > 0 || message.cc.length > 0 || (message.deliveredTo?.length ?? 0) > 0));
}

/** Sender inference stays alias-only. Displaying a primary recipient must not change From defaults. */
export function matchingRecipientAlias(
  messages: readonly RecipientSummary[],
  identities: readonly RecipientIdentity[],
  primary: string,
): string | undefined {
  return matchRecipient(messages, identities, primary, "alias");
}

/** Prefer a known alias, otherwise show a uniquely matched primary address, never an assumed account. */
export function matchingRecipientAddress(
  messages: readonly RecipientSummary[],
  identities: readonly RecipientIdentity[],
  primary: string,
): string | undefined {
  return matchRecipient(messages, identities, primary, "address");
}

/** Header hints are not authenticated delivery evidence. */
function matchRecipient(
  messages: readonly RecipientSummary[],
  identities: readonly RecipientIdentity[],
  primary: string,
  mode: "alias" | "address",
): string | undefined {
  const own = new Set(identities.filter((identity) => !identity.isPrimary).map((identity) => identity.email.toLowerCase()));
  own.delete(primary.toLowerCase());
  const primaries = new Set(mode === "address" ? identities
    .filter((identity) => identity.isPrimary || identity.email.toLowerCase() === primary.toLowerCase())
    .map((identity) => identity.email.toLowerCase()) : []);
  const primaryMatches = new Set<string>();
  let match: string | undefined;
  for (const message of messages) {
    if (!isIncomingRecipientFolder(message.folder)) continue;
    if (primaries.size) {
      for (const email of [...message.to, ...message.cc].map((recipient) => recipient.email.toLowerCase())
        .concat((message.deliveredTo ?? []).map((email) => email.toLowerCase()))) {
        if (primaries.has(email)) primaryMatches.add(email);
      }
    }
    const recipients = new Set([...message.to, ...message.cc].map((recipient) => recipient.email.toLowerCase()).filter((email) => own.has(email)));
    const delivered = new Set((message.deliveredTo ?? []).map((email) => email.toLowerCase()).filter((email) => own.has(email)));
    // Gmail often delivers an alias to the primary address. Preserve a unique
    // To/Cc alias, using Delivered-To only for missing or ambiguous recipients.
    for (const email of recipients.size === 1 || delivered.size === 0 ? recipients : delivered) {
      if (match !== undefined && match !== email) return undefined;
      match = email;
    }
  }
  return match ?? (primaryMatches.size === 1 ? primaryMatches.values().next().value : undefined);
}
