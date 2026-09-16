/**
 * Prompt-injection defense abstraction. Phases 1-4's engines are all
 * deterministic (no LLM call), so nothing here can actually be "hijacked" —
 * but every message is screened anyway so the signal exists in the audit
 * trail (Step 4 surfaces it as `flags.promptInjectionDetected`), and so
 * whichever future phase puts a real LLM behind one of these interfaces
 * inherits working detection on day one instead of bolting it on under
 * deadline pressure.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /forget\s+(everything|all)\s+(above|before)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /act\s+as\s+(a|an)\s+/i,
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /print\s+(your|the)\s+(system\s+)?prompt/i,
  /system\s*prompt\s*:/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /###\s*(system|instruction)/i,
  /\bnew\s+instructions?\s*:/i,
];

export interface SanitizeResult {
  promptInjectionDetected: boolean;
  matchedPatterns: string[];
  /** Injection phrases replaced with a neutral placeholder; safe to hand to any downstream engine. */
  sanitizedText: string;
}

export function sanitizeForProcessing(rawText: string): SanitizeResult {
  const matchedPatterns: string[] = [];
  let sanitizedText = rawText;

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitizedText)) {
      matchedPatterns.push(pattern.source);
      sanitizedText = sanitizedText.replace(pattern, '[REMOVED]');
    }
  }

  return {
    promptInjectionDetected: matchedPatterns.length > 0,
    matchedPatterns,
    sanitizedText,
  };
}
