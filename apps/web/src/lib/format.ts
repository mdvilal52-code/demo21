export function formatFieldName(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
}

// Every word in a SCREAMING_SNAKE_CASE enum value is already upper-case, so
// casing alone can't tell "AI"/"SMS" (keep as an acronym) apart from
// "TO"/"OF" (an ordinary short word) — hence the explicit list.
const ACRONYMS = new Set(['AI', 'SMS', 'SLA', 'ID', 'VIP', 'UAE', 'GCC', 'IDP', 'CRM']);

/** `AI_UNABLE_TO_PROCEED` -> `AI unable to proceed` — for domain enum values (JourneyState, EscalationReason, ...) shown as UI copy. */
export function formatEnumLabel(value: string): string {
  const words = value.split('_').filter(Boolean);
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word;
      return index === 0
        ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        : word.toLowerCase();
    })
    .join(' ');
}
