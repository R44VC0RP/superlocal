type RecipientSummary = {
  folder: string;
  to: readonly { email: string }[];
  cc: readonly { email: string }[];
  deliveredTo?: readonly string[];
};

export type RecipientIdentity = {
  email: string;
  isPrimary: boolean;
};

const nonIncomingFolders = new Set(["sent", "draft", "drafts", "scheduled", "outbox", "unsent", "queued"]);

const isIncomingRecipientFolder = (folder: string): boolean => !nonIncomingFolders.has(folder.toLowerCase());

/** Header recipients from drafts, sends and queued sends are not evidence of incoming delivery. */
export function hasIncomingRecipientHeaders(messages: readonly RecipientSummary[]): boolean {
  return messages.some((message) => isIncomingRecipientFolder(message.folder)
    && (message.to.length > 0 || message.cc.length > 0 || (message.deliveredTo?.length ?? 0) > 0));
}

/** Prefer a unique alias, otherwise a matched primary, across the conversation. Never select From here. */
export function matchingRecipientAddress(
  messages: readonly RecipientSummary[],
  identities: readonly RecipientIdentity[],
  primary: string,
): string | undefined {
  const own = new Set(identities.filter((identity) => !identity.isPrimary).map((identity) => identity.email.toLowerCase()));
  const primaryEmail = primary.toLowerCase();
  own.delete(primaryEmail);
  const primaries = new Set(identities
    .filter((identity) => identity.isPrimary || identity.email.toLowerCase() === primaryEmail)
    .map((identity) => identity.email.toLowerCase()));
  const primaryMatches = new Set<string>();
  let match: string | undefined;
  for (const message of messages) {
    if (!isIncomingRecipientFolder(message.folder)) continue;
    const headerRecipients = [...message.to, ...message.cc].map((recipient) => recipient.email.toLowerCase());
    const deliveredRecipients = (message.deliveredTo ?? []).map((email) => email.toLowerCase());
    if (primaries.size) {
      for (const email of headerRecipients.concat(deliveredRecipients)) {
        if (primaries.has(email)) primaryMatches.add(email);
      }
    }
    const recipients = new Set(headerRecipients.filter((email) => own.has(email)));
    const delivered = new Set(deliveredRecipients.filter((email) => own.has(email)));
    // Gmail often delivers an alias to the primary address. Preserve a unique
    // To/Cc alias, using Delivered-To only for missing or ambiguous recipients.
    for (const email of recipients.size === 1 || delivered.size === 0 ? recipients : delivered) {
      if (match !== undefined && match !== email) return undefined;
      match = email;
    }
  }
  return match ?? (primaryMatches.size === 1 ? primaryMatches.values().next().value : undefined);
}
