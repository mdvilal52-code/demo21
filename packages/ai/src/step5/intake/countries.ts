/**
 * Country names and demonyms → ISO 3166-1 alpha-2, for the markets a Dubai
 * luxury-rental concierge actually sees. Deliberately a closed, reviewable
 * table rather than a fuzzy matcher: an unrecognised nationality is simply
 * "not extracted yet" (the concierge asks again, or the Gemini extractor
 * takes a turn), never a wrong guess feeding an eligibility decision.
 *
 * Every alias is lower-case, ASCII, whitespace-normalised — `findCountryInText`
 * normalises its input the same way before matching whole words.
 */
const COUNTRY_TABLE: ReadonlyArray<readonly [iso2: string, aliases: readonly string[]]> = [
  ['AE', ['uae', 'u a e', 'united arab emirates', 'emirates', 'emirati', 'emirates national']],
  ['SA', ['saudi', 'saudi arabia', 'saudi arabian']],
  ['KW', ['kuwait', 'kuwaiti']],
  ['QA', ['qatar', 'qatari']],
  ['BH', ['bahrain', 'bahraini']],
  ['OM', ['oman', 'omani']],
  ['IN', ['india', 'indian']],
  ['PK', ['pakistan', 'pakistani']],
  ['BD', ['bangladesh', 'bangladeshi']],
  ['LK', ['sri lanka', 'sri lankan']],
  ['NP', ['nepal', 'nepali', 'nepalese']],
  ['AF', ['afghanistan', 'afghan']],
  ['IR', ['iran', 'iranian']],
  ['IQ', ['iraq', 'iraqi']],
  ['JO', ['jordan', 'jordanian']],
  ['LB', ['lebanon', 'lebanese']],
  ['SY', ['syria', 'syrian']],
  ['PS', ['palestine', 'palestinian']],
  ['EG', ['egypt', 'egyptian']],
  ['SD', ['sudan', 'sudanese']],
  ['MA', ['morocco', 'moroccan']],
  ['DZ', ['algeria', 'algerian']],
  ['TN', ['tunisia', 'tunisian']],
  ['LY', ['libya', 'libyan']],
  ['YE', ['yemen', 'yemeni']],
  ['TR', ['turkey', 'turkiye', 'turkish']],
  ['IL', ['israel', 'israeli']],
  ['GB', ['uk', 'u k', 'united kingdom', 'britain', 'british', 'england', 'english', 'scottish']],
  ['IE', ['ireland', 'irish']],
  ['US', ['usa', 'u s a', 'united states', 'american', 'america']],
  ['CA', ['canada', 'canadian']],
  ['AU', ['australia', 'australian']],
  ['NZ', ['new zealand', 'new zealander', 'kiwi']],
  ['ZA', ['south africa', 'south african']],
  ['NG', ['nigeria', 'nigerian']],
  ['KE', ['kenya', 'kenyan']],
  ['GH', ['ghana', 'ghanaian']],
  ['ET', ['ethiopia', 'ethiopian']],
  ['DE', ['germany', 'german']],
  ['FR', ['france', 'french']],
  ['IT', ['italy', 'italian']],
  ['ES', ['spain', 'spanish']],
  ['PT', ['portugal', 'portuguese']],
  ['NL', ['netherlands', 'dutch', 'holland']],
  ['BE', ['belgium', 'belgian']],
  ['CH', ['switzerland', 'swiss']],
  ['AT', ['austria', 'austrian']],
  ['SE', ['sweden', 'swedish']],
  ['NO', ['norway', 'norwegian']],
  ['DK', ['denmark', 'danish']],
  ['FI', ['finland', 'finnish']],
  ['PL', ['poland', 'polish']],
  ['CZ', ['czech republic', 'czech']],
  ['GR', ['greece', 'greek']],
  ['RO', ['romania', 'romanian']],
  ['BG', ['bulgaria', 'bulgarian']],
  ['UA', ['ukraine', 'ukrainian']],
  ['RU', ['russia', 'russian']],
  ['KZ', ['kazakhstan', 'kazakh']],
  ['UZ', ['uzbekistan', 'uzbek']],
  ['AZ', ['azerbaijan', 'azerbaijani']],
  ['GE', ['georgia', 'georgian']],
  ['AM', ['armenia', 'armenian']],
  ['CN', ['china', 'chinese']],
  ['HK', ['hong kong']],
  ['JP', ['japan', 'japanese']],
  ['KR', ['south korea', 'korean']],
  ['SG', ['singapore', 'singaporean']],
  ['MY', ['malaysia', 'malaysian']],
  ['ID', ['indonesia', 'indonesian']],
  ['TH', ['thailand', 'thai']],
  ['VN', ['vietnam', 'vietnamese']],
  ['PH', ['philippines', 'filipino', 'filipina', 'philippine']],
  ['BR', ['brazil', 'brazilian']],
  ['AR', ['argentina', 'argentinian', 'argentine']],
  ['MX', ['mexico', 'mexican']],
  ['CO', ['colombia', 'colombian']],
];

export function normalizeForCountryLookup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIAS_TO_ISO2 = new Map<string, string>();
for (const [iso2, aliases] of COUNTRY_TABLE) {
  for (const alias of aliases) ALIAS_TO_ISO2.set(alias, iso2);
}

/** Longest aliases first, so "south africa"/"sri lanka" win over any shorter alias inside them. */
const ALIASES_LONGEST_FIRST = [...ALIAS_TO_ISO2.keys()].sort((a, b) => b.length - a.length);

/** Looks up one already-isolated phrase ("indian", "sri lankan", "the uae"). */
export function lookupCountry(phrase: string): string | null {
  const normalized = normalizeForCountryLookup(phrase).replace(/^(the|an?) /, '');
  return ALIAS_TO_ISO2.get(normalized) ?? null;
}

/**
 * First country alias appearing as whole words anywhere in `text`, or `null`.
 * When `text` names more than one distinct country the answer is ambiguous
 * (e.g. "Indian living in UAE"), so `null` is returned rather than picking one.
 */
export function findCountryInText(text: string): string | null {
  const haystack = ` ${normalizeForCountryLookup(text)} `;
  const found = new Set<string>();
  for (const alias of ALIASES_LONGEST_FIRST) {
    if (haystack.includes(` ${alias} `)) {
      found.add(ALIAS_TO_ISO2.get(alias) as string);
    }
  }
  return found.size === 1 ? ([...found][0] as string) : null;
}
