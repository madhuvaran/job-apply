/**
 * Deterministic field classifier (Prompt 14).
 *
 * Maps a VALUE-FREE `FieldDescriptor` to a typed classification. It never reads
 * or stores a field's value, never collects arbitrary page text, and never
 * calls the network.
 *
 * Strategy (conservative, documented in the tests):
 * 1. EXCLUSIONS run first and win: passwords/auth, one-time codes, payment &
 *    bank details, CAPTCHA/bot-detection, EEO/voluntary demographics,
 *    compensation, and legal/consent/attestation fields are never autofilled.
 * 2. Strong signals (`autocomplete`, `input[type]`) are preferred over label
 *    text.
 * 3. Weak label/name patterns are word-bounded — a substring inside an
 *    unrelated word ("company name") never matches "first name".
 * 4. Generic labels ("Name", "Other", "Details", "Additional information", …)
 *    are ambiguous unless a strong signal disambiguates them.
 * 5. Multiple matches → ambiguous; no match → unsupported. Never a guess.
 * 6. Custom ARIA combobox/listbox widgets (explicit `role="combobox"`/`listbox`
 *    or `aria-haspopup` listbox/tree/grid) are left for MANUAL entry: the
 *    deterministic engine cannot open a popup or pick an option without
 *    clicking arbitrary page elements. A NATIVE `<select>` is unaffected.
 * 7. A `placeholder` is only a LOWER-CONFIDENCE fallback (Prompt 22): when the
 *    control has a real label or ARIA name, the placeholder does not create a
 *    competing category. It still feeds the safety exclusions, so a misleading
 *    label can never unlock a sensitive field.
 * 8. Fieldset/legend context is a LAST RESORT, used only when the control has no
 *    label, ARIA name or placeholder of its own — a group question never
 *    overrides a per-control label.
 */
import type { FieldCategory, FieldClassification, FieldDescriptor } from './schemas';

/** Lowercase, keep digits, collapse everything else to single spaces. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Labels too generic to classify on their own. */
const GENERIC_LABELS = new Set([
  'name',
  'full name',
  'other',
  'details',
  'additional information',
  'additional info',
  'additional',
  'info',
  'information',
  'comments',
  'comment',
  'notes',
  'note',
  'message',
  'answer',
  'value',
  'text',
  'field',
  'please specify',
  'specify',
  'enter value',
  'type here',
  'input',
]);

interface Exclusion {
  reason: string;
  test: (descriptor: FieldDescriptor, corpus: string) => boolean;
}

/** Ordered; the first match wins. Reasons are fixed literals (no values). */
const EXCLUSIONS: Exclusion[] = [
  {
    reason: 'Password and authentication fields are never filled.',
    // The control's OWN type is checked first (Prompt 22): a `type=password`
    // control with an innocuous label/placeholder is still never filled, even
    // though a deceptive label might otherwise look like a supported category.
    test: (d, c) =>
      (d.inputType ?? '').toLowerCase() === 'password' ||
      /\bpassword\b|\bpasscode\b|\bpassphrase\b|\bpin\b|\busername\b|\buser name\b|\blogin\b|\blog in\b|\bsign in\b|\bsignin\b|\bauthenticat/.test(
        c,
      ),
  },
  {
    reason: 'One-time codes and verification codes are never filled.',
    test: (_d, c) =>
      /\b2fa\b|\btwofactor\b|\btwo factor\b|\bone time\b|\botp\b|\bverification code\b|\bsecurity code\b|\bsms code\b|\bauthenticator\b|\bverification pin\b/.test(
        c,
      ),
  },
  {
    reason: 'Payment and bank details are never filled.',
    test: (_d, c) =>
      /\bcredit card\b|\bcard number\b|\bcard no\b|\bcvv\b|\bcvc\b|\bccv\b|\bexpiry\b|\bexpiration\b|\bbilling\b|\biban\b|\baccount number\b|\brouting\b|\bbank\b|\bpayment\b|\bpaypal\b|\bdebit\b/.test(
        c,
      ),
  },
  {
    reason: 'CAPTCHA and bot-detection fields are never filled.',
    test: (_d, c) =>
      /\bcaptcha\b|\brecaptcha\b|\bhcaptcha\b|\bturnstile\b|\bnot a robot\b|\brobot\b|\bbot detection\b|\bhuman verification\b/.test(
        c,
      ),
  },
  {
    reason: 'Voluntary demographic (EEO) questions are never filled.',
    test: (_d, c) =>
      /\bgender\b|\bsex\b|\brace\b|\bethnicit|\bveteran\b|\bdisabilit|\bdisabled\b|\breligion\b|\bsexual orientation\b|\bpronoun\b|\blgbt|\bmarital status\b|\bage\b/.test(
        c,
      ),
  },
  {
    reason: 'Compensation and salary questions are never filled.',
    test: (_d, c) =>
      /\bsalary\b|\bcompensation\b|\bpay rate\b|\bpayrate\b|\bexpected pay\b|\bdesired pay\b|\bhourly rate\b|\bremuneration\b|\bannual pay\b|\bday rate\b|\bpay expectation\b/.test(
        c,
      ),
  },
  {
    reason: 'Legal declarations, consent and attestation fields are never filled.',
    test: (_d, c) =>
      /\bi agree\b|\bagree\b|\bconsent\b|\bterms\b|\bprivacy policy\b|\battest\b|\bdeclar|\bcertif|\backnowledg|\bsignature\b|\bbackground check\b|\bdrug test\b|\bterms of\b|\baccept\b|\bopt in\b|\bopt out\b/.test(
        c,
      ),
  },
  {
    reason: 'Hidden fields are never filled.',
    test: (d) => (d.inputType ?? '').toLowerCase() === 'hidden',
  },
];

const FIRST_NAME = /\bfirst name\b|\bgiven name\b|\bfirstname\b|\bfname\b/;
const LAST_NAME = /\blast name\b|\bfamily name\b|\blastname\b|\blname\b|\bsurname\b/;
const EMAIL = /\bemail\b|\be mail\b/;
const PHONE = /\bphone\b|\bmobile\b|\btelephone\b|\bcell\b|\bphone number\b/;
const CITY = /\bcity\b|\btown\b/;
const STATE = /\bstate\b|\bprovince\b|\bregion\b/;
const COUNTRY = /\bcountry\b/;
const LINKEDIN = /\blinkedin\b/;
const PORTFOLIO = /\bportfolio\b|\bpersonal website\b|\bpersonal site\b|\bwebsite\b|\bhomepage\b/;
const SKILLS = /\bskills\b|\bkey skills\b|\btechnical skills\b|\btechnologies\b/;
const SUMMARY = /\bsummary\b|\bprofessional summary\b|\babout you\b|\babout me\b|\bbio\b/;
const WORK_AUTH =
  /\bwork authoriz|\bauthorized to work\b|\blegally authorized\b|\beligib\w* to work\b|\bright to work\b|\bwork permit\b|\bwork eligibility\b/;
const SPONSORSHIP = /\bsponsor/;
const SPONSORSHIP_NEGATED = /\bwithout spons|\bno spons|\bnot require spons/;

/**
 * `aria-haspopup` values that indicate an option-selection widget (a listbox
 * popup). `true`/`menu` are excluded — those are menus, not form pickers.
 */
const CUSTOM_SELECTION_POPUPS = new Set(['listbox', 'tree', 'grid']);

/**
 * An explicit ARIA combobox/listbox selection widget. Native `<select>` and
 * plain text/textarea/radio/checkbox controls are NOT affected.
 */
export function isCustomSelectionWidget(descriptor: FieldDescriptor): boolean {
  if (descriptor.kind === 'select') return false;
  const role = (descriptor.role ?? '').toLowerCase();
  if (role === 'combobox' || role === 'listbox') return true;
  return CUSTOM_SELECTION_POPUPS.has((descriptor.ariaHasPopup ?? '').toLowerCase());
}

/** Choice-kind fields only support these categories. */
const CHOICE_CATEGORIES = new Set<FieldCategory>(['state', 'country', 'workAuthorization', 'sponsorship']);

function primaryLabel(descriptor: FieldDescriptor): string {
  return normalizeText(
    descriptor.labelText ??
      descriptor.ariaLabel ??
      descriptor.placeholder ??
      descriptor.groupLabel ??
      '',
  );
}

/** The control's own label/ARIA name (never a value, never group context). */
function ownLabel(descriptor: FieldDescriptor): string | undefined {
  return descriptor.labelText ?? descriptor.ariaLabel;
}

/**
 * Fieldset/legend context (Prompt 22) is a LAST-RESORT signal: it is only
 * consulted for a control that has no label, ARIA name or placeholder of its
 * own, so a group question can never override a per-control label. Bounded and
 * value-free — the page scan never persists or transmits it.
 */
function groupContext(descriptor: FieldDescriptor): string | undefined {
  if (ownLabel(descriptor) !== undefined || descriptor.placeholder !== undefined) return undefined;
  return descriptor.groupLabel;
}

function joinCorpus(parts: Array<string | undefined>): string {
  return normalizeText(parts.filter((v): v is string => typeof v === 'string' && v.length > 0).join(' '));
}

/**
 * SAFETY corpus — EVERY signal, including the placeholder. Used by the
 * exclusions, so a misleading label can never unlock a sensitive field (e.g. a
 * label of "First name" with a placeholder of "Enter your password").
 */
function buildCorpus(descriptor: FieldDescriptor): string {
  return joinCorpus([
    descriptor.labelText,
    descriptor.ariaLabel,
    descriptor.placeholder,
    descriptor.name,
    descriptor.elementId,
    descriptor.autocomplete,
    groupContext(descriptor),
  ]);
}

/**
 * MATCH corpus — used for category detection. A placeholder is only a
 * LOWER-CONFIDENCE fallback: when the control has a real label/ARIA name, its
 * (often boilerplate or contradictory) placeholder hint is not allowed to
 * create a competing category. Everything else, including legend context, is
 * identical to the safety corpus.
 */
function buildMatchCorpus(descriptor: FieldDescriptor): string {
  return joinCorpus([
    descriptor.labelText,
    descriptor.ariaLabel,
    ownLabel(descriptor) === undefined ? descriptor.placeholder : undefined,
    descriptor.name,
    descriptor.elementId,
    descriptor.autocomplete,
    groupContext(descriptor),
  ]);
}

/** Candidate categories from strong attributes + word-bounded label patterns. */
function detectCategories(descriptor: FieldDescriptor, corpus: string): Set<FieldCategory> {
  const cats = new Set<FieldCategory>();
  const autocomplete = (descriptor.autocomplete ?? '').toLowerCase();
  const tokens = autocomplete.split(/\s+/);
  const has = (t: string): boolean => tokens.includes(t);
  const type = (descriptor.inputType ?? '').toLowerCase();

  // Strong signals.
  if (has('given-name')) cats.add('firstName');
  if (has('family-name')) cats.add('lastName');
  if (has('email')) cats.add('email');
  if (has('tel') || has('tel-national')) cats.add('phone');
  if (has('address-level2')) cats.add('city');
  if (has('address-level1')) cats.add('state');
  if (has('country') || has('country-name')) cats.add('country');
  if (type === 'email') cats.add('email');
  if (type === 'tel') cats.add('phone');

  // Weak (word-bounded) label/name patterns.
  if (FIRST_NAME.test(corpus)) cats.add('firstName');
  if (LAST_NAME.test(corpus)) cats.add('lastName');
  if (EMAIL.test(corpus)) cats.add('email');
  if (PHONE.test(corpus)) cats.add('phone');
  if (CITY.test(corpus)) cats.add('city');
  if (STATE.test(corpus)) cats.add('state');
  if (COUNTRY.test(corpus)) cats.add('country');
  if (LINKEDIN.test(corpus)) cats.add('linkedin');
  else if (PORTFOLIO.test(corpus)) cats.add('portfolio');
  if (SKILLS.test(corpus)) cats.add('skills');
  if (SUMMARY.test(corpus)) cats.add('summary');
  if (WORK_AUTH.test(corpus)) cats.add('workAuthorization');
  if (SPONSORSHIP.test(corpus)) cats.add('sponsorship');

  return cats;
}

/** Classify one descriptor. Deterministic and side-effect free. */
export function classifyField(descriptor: FieldDescriptor): FieldClassification {
  const corpus = buildCorpus(descriptor);
  const matchCorpus = buildMatchCorpus(descriptor);
  const label = primaryLabel(descriptor);
  const type = (descriptor.inputType ?? '').toLowerCase();

  // 1. Exclusions win outright.
  for (const exclusion of EXCLUSIONS) {
    if (exclusion.test(descriptor, corpus)) {
      return { kind: 'excluded', reason: exclusion.reason };
    }
  }

  // Non-form / deliberately unsupported controls.
  if (type === 'search' || type === 'submit' || type === 'button' || type === 'file' || type === 'image' || type === 'reset') {
    return { kind: 'unsupported', reason: 'This control type is not autofilled.' };
  }
  if (isCustomSelectionWidget(descriptor)) {
    return {
      kind: 'ambiguous',
      reason: 'Custom combobox/listbox — open the picker and choose it manually.',
    };
  }
  if (SPONSORSHIP.test(corpus) && SPONSORSHIP_NEGATED.test(corpus)) {
    return { kind: 'ambiguous', reason: 'Sponsorship wording is ambiguous — left for manual entry.' };
  }

  const categories = detectCategories(descriptor, matchCorpus);

  if (categories.size === 0) {
    if (label.length > 0 && GENERIC_LABELS.has(label)) {
      return { kind: 'ambiguous', reason: 'Generic label — not enough context to classify safely.' };
    }
    return { kind: 'unsupported', reason: 'Not a supported application field.' };
  }
  if (categories.size > 1) {
    return { kind: 'ambiguous', reason: 'Matches more than one field category — left for manual entry.' };
  }

  const category = [...categories][0] as FieldCategory;
  if ((descriptor.kind === 'radio' || descriptor.kind === 'checkbox') && !CHOICE_CATEGORIES.has(category)) {
    return {
      kind: 'ambiguous',
      reason: 'Choice field for an unsupported category — left for manual entry.',
    };
  }
  return { kind: 'supported', category };
}
