/**
 * A client dossier: who the assessment is for, and the scope they signed.
 *
 * The signed scope is what bounds a campaign at authoring time — its targets and its volume
 * ceiling. It is not an authorization: the allowlist, the approval and the execute permission
 * remain the gates. A dossier is a contract reference, not a bypass.
 */
export interface DrsClientContact {
  name: string;
  email: string;
  role?: string;
}

export interface DrsClientScope {
  /** Reference of the signed document (contract, SOW, order form). */
  reference: string;
  signedAt: string;
  /** Targets the client authorised. A campaign target must appear in this list. */
  targets: string[];
  /** Volume ceiling the client agreed to, in requests per second. */
  maxRps: number;
}

export interface DrsClient {
  id: string;
  name: string;
  contacts: DrsClientContact[];
  scope: DrsClientScope;
  createdAt: string;
  updatedAt: string;
}

export class DrsClientError extends Error {}

const text = (v: unknown, field: string, max = 120): string => {
  if (typeof v !== 'string' || v.trim().length < 2 || v.trim().length > max)
    throw new DrsClientError(`${field} must be 2–${max} characters.`);
  return v.trim();
};

const isoDate = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)))
    throw new DrsClientError(`${field} must be an ISO date.`);
  return new Date(v).toISOString();
};

/** Validate an input the way the API receives it; throws DrsClientError on the first problem. */
export function parseClientInput(
  input: unknown,
  now = new Date(),
): Omit<DrsClient, 'id' | 'createdAt' | 'updatedAt'> {
  if (typeof input !== 'object' || input === null)
    throw new DrsClientError('A client object is required.');
  const raw = input as Record<string, unknown>;
  const scopeRaw = (raw.scope ?? {}) as Record<string, unknown>;
  const contactsRaw = Array.isArray(raw.contacts) ? raw.contacts : [];
  if (contactsRaw.length === 0) throw new DrsClientError('At least one contact is required.');
  const contacts = contactsRaw.slice(0, 10).map((c, i) => {
    const contact = (c ?? {}) as Record<string, unknown>;
    const email = text(contact.email, `contacts[${i}].email`, 160);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new DrsClientError(`contacts[${i}].email is not an address.`);
    return {
      name: text(contact.name, `contacts[${i}].name`, 80),
      email,
      ...(typeof contact.role === 'string' && contact.role.trim()
        ? { role: contact.role.trim().slice(0, 40) }
        : {}),
    };
  });
  const targetsRaw = Array.isArray(scopeRaw.targets) ? scopeRaw.targets : [];
  const targets = [...new Set(targetsRaw.map((t) => text(t, 'scope.targets[]', 300)))];
  if (targets.length === 0) throw new DrsClientError('scope.targets needs at least one target.');
  const maxRps = Number(scopeRaw.maxRps);
  if (!Number.isFinite(maxRps) || maxRps <= 0)
    throw new DrsClientError('scope.maxRps must be a positive number.');
  const signedAt = isoDate(scopeRaw.signedAt, 'scope.signedAt');
  if (Date.parse(signedAt) > now.getTime())
    throw new DrsClientError('scope.signedAt cannot be in the future.');
  return {
    name: text(raw.name, 'name'),
    contacts,
    scope: {
      reference: text(scopeRaw.reference, 'scope.reference', 80),
      signedAt,
      targets,
      maxRps,
    },
  };
}
