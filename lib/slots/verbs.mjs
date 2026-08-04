// Report verbs: the worker->dispatcher triage vocabulary. A report leads with
// "<verb>:" so supervision can tell "needs me" from "just telling me". Verbs are
// parsed at READ time and never persisted - the inbox record schema stays unbumped,
// so a version-skewed reader (this machine runs two MCP registrations resolving two
// binaries) can never drop new reports as malformed. The parse rule can tighten or
// loosen without stranding frozen stamps in the data.

/** The verbs a report may lead with; anything else parses null. */
export const VERBS = ['done', 'blocked', 'needs-decision', 'failed', 'working', 'paused'];

const VERB_RE = /^(done|blocked|needs-decision|failed|working|paused)\s*:/i;

/**
 * The triage verb of a report message, or null when it declares none (unknown demands
 * attention - null SURFACES; see the supervision spec). Pure and total: any input,
 * never throws.
 * @param {string} message - The report text.
 * @returns {'done'|'blocked'|'needs-decision'|'failed'|'working'|'paused'|null} the verb.
 */
export function parseVerb(message) {
  const match = typeof message === 'string' ? VERB_RE.exec(message) : null;
  return match ? match[1].toLowerCase() : null;
}
