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

/** Match header hints only against known aliases. This is not authenticated delivery evidence. */
export function matchingRecipientAlias(
  messages: readonly RecipientSummary[],
  identities: readonly RecipientIdentity[],
  primary: string,
): string | undefined {
  const own = new Set(identities.filter((identity) => !identity.isPrimary).map((identity) => identity.email.toLowerCase()));
  own.delete(primary.toLowerCase());
  let match: string | undefined;
  for (const message of messages) {
    if (!isIncomingRecipientFolder(message.folder)) continue;
    const recipients = new Set([...message.to, ...message.cc].map((recipient) => recipient.email.toLowerCase()).filter((email) => own.has(email)));
    const delivered = new Set((message.deliveredTo ?? []).map((email) => email.toLowerCase()).filter((email) => own.has(email)));
    // Gmail often delivers an alias to the primary address. Preserve a unique
    // To/Cc alias, using Delivered-To only for missing or ambiguous recipients.
    for (const email of recipients.size === 1 || delivered.size === 0 ? recipients : delivered) {
      if (match !== undefined && match !== email) return undefined;
      match = email;
    }
  }
  return match;
}
