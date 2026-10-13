/**
 * Text normalization + conservative matching vocabulary (Prompt 09).
 *
 * Design rules:
 * - CONSERVATIVE ALIASES ONLY: an alias is accepted only when the equivalence
 *   is defensible (k8s ≡ Kubernetes, Node.js ≡ Node, Postgres ≡ PostgreSQL).
 *   Ambiguous short words that appear in prose ("rest", "spring", "express")
 *   are deliberately NOT aliases.
 * - WORD-BOUNDARY MATCHING ONLY: "java" never matches inside "javascript",
 *   ".net" never matches inside "asp.net", and when two matches overlap the
 *   LONGER one wins ("node.js" resolves to `node`, not to `js`).
 * - Whole-word matches only; the raw job description is never scanned —
 *   matching runs over the structured posting fields (skills / required /
 *   preferred) that the deterministic intake extraction produced.
 * - Pure module: no DOM, no network, no storage, no clock.
 */

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalize text for matching: strip diacritics, lowercase, turn punctuation
 * into spaces, but KEEP `#`, `+` and `.` so c#, c++ and node.js survive.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized tokens of a string (empty array when nothing survives). */
export function tokens(input: string): string[] {
  const normalized = normalizeForMatch(input);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** Collapse whitespace and bound the length for display labels (no content invention). */
export function displayLabel(input: string, max = 120): string {
  const collapsed = input.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary matcher for a normalized alias (lookaround excludes inner words). */
function aliasRegex(alias: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegex(alias)}(?![a-z0-9])`);
}

/* ------------------------------------------------------------------ */
/* Skill vocabulary                                                    */
/* ------------------------------------------------------------------ */

export interface VocabularyEntry {
  /** Stable canonical id used in requirement ids and comparisons. */
  id: string;
  /** Display label (canonical casing). */
  label: string;
  /** Accepted aliases, stored as raw strings; normalized at table build time. */
  aliases: string[];
}

/**
 * Curated, deliberately small vocabulary of technical skills. Matching is
 * scoped to this vocabulary: a posting requirement we cannot recognize is NOT
 * assessed (never guessed). Extend conservatively.
 */
export const SKILL_VOCABULARY: readonly VocabularyEntry[] = [
  { id: 'typescript', label: 'TypeScript', aliases: ['TypeScript'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['JavaScript', 'JS'] },
  { id: 'node', label: 'Node.js', aliases: ['Node', 'Node.js', 'NodeJS'] },
  { id: 'react', label: 'React', aliases: ['React', 'ReactJS', 'React.js'] },
  { id: 'react-native', label: 'React Native', aliases: ['React Native', 'ReactNative'] },
  { id: 'nextjs', label: 'Next.js', aliases: ['Next.js', 'NextJS'] },
  { id: 'vue', label: 'Vue', aliases: ['Vue', 'Vue.js', 'VueJS'] },
  { id: 'angular', label: 'Angular', aliases: ['Angular', 'AngularJS'] },
  { id: 'svelte', label: 'Svelte', aliases: ['Svelte'] },
  { id: 'python', label: 'Python', aliases: ['Python'] },
  { id: 'java', label: 'Java', aliases: ['Java'] },
  { id: 'go', label: 'Go', aliases: ['Go', 'Golang'] },
  { id: 'rust', label: 'Rust', aliases: ['Rust'] },
  { id: 'kotlin', label: 'Kotlin', aliases: ['Kotlin'] },
  { id: 'swift', label: 'Swift', aliases: ['Swift'] },
  { id: 'php', label: 'PHP', aliases: ['PHP'] },
  { id: 'ruby', label: 'Ruby', aliases: ['Ruby'] },
  { id: 'rails', label: 'Ruby on Rails', aliases: ['Rails', 'Ruby on Rails'] },
  { id: 'csharp', label: 'C#', aliases: ['C#', 'CSharp'] },
  { id: 'cpp', label: 'C++', aliases: ['C++', 'CPP'] },
  { id: 'dotnet', label: '.NET', aliases: ['.NET', 'DotNET'] },
  { id: 'sql', label: 'SQL', aliases: ['SQL'] },
  { id: 'postgresql', label: 'PostgreSQL', aliases: ['PostgreSQL', 'Postgres'] },
  { id: 'mysql', label: 'MySQL', aliases: ['MySQL'] },
  { id: 'mongodb', label: 'MongoDB', aliases: ['MongoDB', 'Mongo'] },
  { id: 'redis', label: 'Redis', aliases: ['Redis'] },
  { id: 'graphql', label: 'GraphQL', aliases: ['GraphQL'] },
  { id: 'rest-api', label: 'REST APIs', aliases: ['REST API', 'RESTful API', 'RESTful'] },
  { id: 'html', label: 'HTML', aliases: ['HTML'] },
  { id: 'css', label: 'CSS', aliases: ['CSS'] },
  { id: 'sass', label: 'Sass', aliases: ['Sass', 'SCSS'] },
  { id: 'tailwind', label: 'Tailwind CSS', aliases: ['Tailwind', 'TailwindCSS'] },
  { id: 'aws', label: 'AWS', aliases: ['AWS', 'Amazon Web Services'] },
  { id: 'gcp', label: 'Google Cloud', aliases: ['GCP', 'Google Cloud'] },
  { id: 'azure', label: 'Azure', aliases: ['Azure'] },
  { id: 'docker', label: 'Docker', aliases: ['Docker'] },
  { id: 'kubernetes', label: 'Kubernetes', aliases: ['Kubernetes', 'K8s'] },
  { id: 'terraform', label: 'Terraform', aliases: ['Terraform'] },
  { id: 'cicd', label: 'CI/CD', aliases: ['CI/CD', 'CI CD', 'CICD', 'Continuous Integration', 'Continuous Delivery'] },
  { id: 'git', label: 'Git', aliases: ['Git'] },
  { id: 'linux', label: 'Linux', aliases: ['Linux'] },
  { id: 'elasticsearch', label: 'Elasticsearch', aliases: ['Elasticsearch', 'Elastic Search'] },
  { id: 'kafka', label: 'Kafka', aliases: ['Kafka'] },
  { id: 'rabbitmq', label: 'RabbitMQ', aliases: ['RabbitMQ', 'Rabbit MQ'] },
  { id: 'spring-boot', label: 'Spring Boot', aliases: ['Spring Boot', 'SpringBoot'] },
  { id: 'jest', label: 'Jest', aliases: ['Jest'] },
  { id: 'cypress', label: 'Cypress', aliases: ['Cypress'] },
  { id: 'playwright', label: 'Playwright', aliases: ['Playwright'] },
  { id: 'selenium', label: 'Selenium', aliases: ['Selenium'] },
  { id: 'figma', label: 'Figma', aliases: ['Figma'] },
];

/* ------------------------------------------------------------------ */
/* Certification + education vocabularies                              */
/* ------------------------------------------------------------------ */

/** Named certifications the matcher can verify by name. Small on purpose. */
export const CERTIFICATION_VOCABULARY: readonly VocabularyEntry[] = [
  { id: 'pmp', label: 'PMP', aliases: ['PMP'] },
  { id: 'cka', label: 'CKA (Certified Kubernetes Administrator)', aliases: ['CKA', 'Certified Kubernetes Administrator'] },
  { id: 'aws-saa', label: 'AWS Certified Solutions Architect', aliases: ['AWS Certified Solutions Architect'] },
];

export const EDUCATION_LEVELS = ['bachelor', 'master', 'doctorate'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

const EDUCATION_ALIASES: Record<EducationLevel | 'degree', readonly string[]> = {
  doctorate: ['phd', 'ph.d', 'doctorate', 'doctoral', 'dphil'],
  master: ["master's", 'masters', 'master degree', 'msc', 'm.sc', 'm.a', 'mba'],
  bachelor: ["bachelor's", 'bachelors', 'bachelor degree', 'bsc', 'b.sc', 'b.a', 'undergraduate degree'],
  degree: ['degree'],
};

/* ------------------------------------------------------------------ */
/* Match table (built once, deterministically sorted)                  */
/* ------------------------------------------------------------------ */

interface CompiledAlias {
  regex: RegExp;
  canonicalId: string;
  label: string;
  length: number;
}

function compileTable(entries: readonly VocabularyEntry[]): CompiledAlias[] {
  const compiled: CompiledAlias[] = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const normalized = normalizeForMatch(alias);
      if (normalized.length === 0) continue;
      compiled.push({
        regex: aliasRegex(normalized),
        canonicalId: entry.id,
        label: entry.label,
        length: normalized.length,
      });
    }
  }
  // Longest alias first so "react native" wins over "react", "node.js" over "js".
  compiled.sort((a, b) => b.length - a.length || a.canonicalId.localeCompare(b.canonicalId));
  return compiled;
}

const SKILL_TABLE = compileTable(SKILL_VOCABULARY);
const CERT_TABLE = compileTable(CERTIFICATION_VOCABULARY);

/**
 * Resolve a skill mention (a whole skill entry or a phrase inside a line) to
 * its canonical vocabulary id, or null when the text is not in the
 * vocabulary (never guessed).
 */
export function canonicalizeSkill(mention: string): string | null {
  const normalized = normalizeForMatch(mention);
  if (normalized.length === 0) return null;
  for (const entry of SKILL_TABLE) {
    if (entry.regex.test(normalized)) return entry.canonicalId;
  }
  return null;
}

/** All DISTINCT skill vocabulary ids mentioned in a line, longest-match-wins. */
export function findSkillMentions(line: string): string[] {
  const normalized = normalizeForMatch(line);
  if (normalized.length === 0) return [];
  const found: Array<{ id: string; start: number; end: number }> = [];
  for (const entry of SKILL_TABLE) {
    const match = entry.regex.exec(normalized);
    if (match === null || match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    // Drop shorter matches that overlap an already accepted (longer) match.
    if (found.some((f) => start < f.end && end > f.start)) continue;
    found.push({ id: entry.canonicalId, start, end });
  }
  return [...new Set(found.map((f) => f.id))];
}

/** Resolve a named certification to its canonical id, or null. */
export function canonicalizeCertification(mention: string): string | null {
  const normalized = normalizeForMatch(mention);
  if (normalized.length === 0) return null;
  for (const entry of CERT_TABLE) {
    if (entry.regex.test(normalized)) return entry.canonicalId;
  }
  return null;
}

const EDUCATION_TABLE: Array<{ level: EducationLevel | 'degree'; regex: RegExp }> = (
  ['doctorate', 'master', 'bachelor', 'degree'] as const
).map((level) => ({
  level,
  // Each alternative is escaped individually, then alternated — escaping the
  // joined string would also escape the `|` separators (learned the hard way).
  regex: new RegExp(
    `(?<![a-z0-9])${EDUCATION_ALIASES[level]
      .map((alias) => escapeRegex(normalizeForMatch(alias)))
      .join('|')}(?![a-z0-9])`,
  ),
}));

/**
 * Detect the highest education level mentioned in free text. `degree` means a
 * degree was mentioned WITHOUT a recognizable level. Conservative regexes —
 * unrecognizable credential text yields null (never guessed).
 */
export function educationLevelFromText(text: string): EducationLevel | 'degree' | null {
  const normalized = normalizeForMatch(text);
  if (normalized.length === 0) return null;
  for (const entry of EDUCATION_TABLE) {
    if (entry.regex.test(normalized)) return entry.level;
  }
  return null;
}

/** Display label for a detected education level. */
export function educationLevelLabel(level: EducationLevel | 'degree'): string {
  switch (level) {
    case 'doctorate':
      return 'Doctorate';
    case 'master':
      return "Master's degree";
    case 'bachelor':
      return "Bachelor's degree";
    case 'degree':
      return 'A degree';
  }
}

const LEVEL_RANK: Record<EducationLevel | 'degree', number> = {
  degree: 0,
  bachelor: 1,
  master: 2,
  doctorate: 3,
};

/** Rank used to compare the candidate's highest completed level vs required. */
export function educationLevelRank(level: EducationLevel | 'degree'): number {
  return LEVEL_RANK[level];
}

/* ------------------------------------------------------------------ */
/* Title helpers                                                       */
/* ------------------------------------------------------------------ */

const TITLE_STOPWORDS = new Set([
  'senior',
  'junior',
  'sr',
  'jr',
  'lead',
  'principal',
  'staff',
  'chief',
  'head',
  'vp',
  'vice',
  'president',
  'director',
  'manager',
  'i',
  'ii',
  'iii',
  'iv',
  'the',
  'of',
  'and',
  'a',
  'an',
]);

/**
 * Meaningful tokens of a job title: level/title-management words are removed
 * so "Senior Backend Engineer" and "Backend Engineer" align on
 * {backend, engineer}.
 */
export function titleTokens(title: string): string[] {
  return tokens(title).filter((t) => !TITLE_STOPWORDS.has(t));
}

/**
 * True when `phrase` appears in `haystack` as a whole-word phrase (normalized,
 * word-bounded — "java" never matches inside "javascript").
 */
export function containsPhrase(haystack: string, phrase: string): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  const normalizedPhrase = normalizeForMatch(phrase);
  if (normalizedHaystack.length === 0 || normalizedPhrase.length === 0) return false;
  return aliasRegex(normalizedPhrase).test(normalizedHaystack);
}

/**
 * Token-sequence prefix test used for PARTIAL (adjacent-evidence) matches:
 * "react" is a prefix of "react native", but "java" is NOT a prefix of
 * "javascript" (single token, not a token sequence).
 */
export function isStrictTokenPrefix(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0 || ta.length === tb.length) return false;
  const [short, long] = ta.length < tb.length ? [ta, tb] : [tb, ta];
  return short.every((t, i) => long[i] === t);
}
