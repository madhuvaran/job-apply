/**
 * Classifier tests (Prompt 14) — synthetic, value-free descriptors only.
 */
import { describe, expect, it } from 'vitest';
import { classifyField, normalizeText } from './classify';
import { fieldDescriptorSchema, type FieldDescriptor } from './schemas';

function d(partial: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return fieldDescriptorSchema.parse({ fieldId: 'f1', kind: 'text', ...partial });
}

const category = (partial: Partial<FieldDescriptor>): string | null => {
  const result = classifyField(d(partial));
  return result.kind === 'supported' ? result.category : null;
};

describe('normalizeText', () => {
  it('lowercases, keeps digits, and collapses punctuation/whitespace', () => {
    expect(normalizeText('  First   NAME!! ')).toBe('first name');
    expect(normalizeText('e-mail')).toBe('e mail');
    expect(normalizeText('2FA')).toBe('2fa');
  });
});

describe('supported fields', () => {
  it('classifies common name/contact fields from labels and attributes', () => {
    expect(category({ labelText: 'First name' })).toBe('firstName');
    expect(category({ labelText: 'Last Name' })).toBe('lastName');
    expect(category({ name: 'fname' })).toBe('firstName');
    expect(category({ name: 'surname' })).toBe('lastName');
    expect(category({ kind: 'text', inputType: 'email' })).toBe('email');
    expect(category({ labelText: 'E-mail address' })).toBe('email');
    expect(category({ kind: 'text', inputType: 'tel' })).toBe('phone');
    expect(category({ labelText: 'Mobile number' })).toBe('phone');
    expect(category({ autocomplete: 'given-name' })).toBe('firstName');
  });

  it('classifies location, links, skills, summary and work-authorization fields', () => {
    expect(category({ labelText: 'City' })).toBe('city');
    expect(category({ autocomplete: 'address-level2' })).toBe('city');
    expect(category({ labelText: 'State / Province' })).toBe('state');
    expect(category({ labelText: 'Country' })).toBe('country');
    expect(category({ labelText: 'LinkedIn profile' })).toBe('linkedin');
    expect(category({ labelText: 'Portfolio / website' })).toBe('portfolio');
    expect(category({ kind: 'textarea', labelText: 'Key skills' })).toBe('skills');
    expect(category({ kind: 'textarea', labelText: 'Professional summary' })).toBe('summary');
    expect(category({ kind: 'select', labelText: 'Are you legally authorized to work here?' })).toBe(
      'workAuthorization',
    );
    expect(category({ kind: 'select', labelText: 'Will you require sponsorship?' })).toBe('sponsorship');
  });
});

describe('weak / ambiguous / generic fields', () => {
  it('never matches a category from an unrelated substring', () => {
    expect(classifyField(d({ labelText: 'Company name', name: 'company' })).kind).toBe('unsupported');
    expect(classifyField(d({ labelText: 'Nickname' })).kind).toBe('unsupported');
    expect(classifyField(d({ labelText: 'Favorite color' })).kind).toBe('unsupported');
  });

  it('treats generic labels as ambiguous', () => {
    for (const label of ['Name', 'Other', 'Details', 'Additional information', 'Message']) {
      const result = classifyField(d({ labelText: label }));
      expect(result.kind, label).toBe('ambiguous');
    }
  });

  it('flags multiple matches and negated sponsorship wording as ambiguous', () => {
    expect(classifyField(d({ labelText: 'Email or phone' })).kind).toBe('ambiguous');
    expect(classifyField(d({ kind: 'select', labelText: 'Do you require sponsorship without sponsorship?' })).kind).toBe(
      'ambiguous',
    );
  });

  it('does not support choice controls for non-choice categories', () => {
    expect(classifyField(d({ kind: 'checkbox', labelText: 'First name' })).kind).toBe('ambiguous');
    expect(classifyField(d({ kind: 'radio', labelText: 'Email' })).kind).toBe('ambiguous');
  });

  it('marks non-form controls unsupported', () => {
    expect(classifyField(d({ inputType: 'search', labelText: 'Search jobs' })).kind).toBe('unsupported');
    expect(classifyField(d({ inputType: 'file', labelText: 'Resume' })).kind).toBe('unsupported');
  });
});

describe('excluded (never filled) categories', () => {
  const excluded = (partial: Partial<FieldDescriptor>): string => {
    const result = classifyField(d(partial));
    expect(result.kind).toBe('excluded');
    return result.kind === 'excluded' ? result.reason : '';
  };

  it('excludes credentials, OTP, payment/bank, CAPTCHA and legal fields', () => {
    expect(excluded({ kind: 'text', inputType: 'password', labelText: 'Password' })).toMatch(/Password/i);
    expect(excluded({ name: 'username' })).toMatch(/authentication/i);
    expect(excluded({ labelText: 'One-time code' })).toMatch(/One-time codes/i);
    expect(excluded({ labelText: 'Credit card number' })).toMatch(/Payment and bank/i);
    expect(excluded({ labelText: 'CVV' })).toMatch(/Payment and bank/i);
    expect(excluded({ labelText: "I'm not a robot" })).toMatch(/CAPTCHA/i);
    expect(excluded({ kind: 'checkbox', labelText: 'I agree to the terms and conditions' })).toMatch(/Legal/i);
    expect(excluded({ labelText: 'Signature' })).toMatch(/Legal/i);
  });

  it('excludes voluntary demographics and compensation', () => {
    expect(excluded({ kind: 'select', labelText: 'Gender' })).toMatch(/demographic/i);
    expect(excluded({ kind: 'select', labelText: 'Veteran status' })).toMatch(/demographic/i);
    expect(excluded({ labelText: 'Expected salary' })).toMatch(/Compensation/i);
    expect(excluded({ labelText: 'Desired compensation' })).toMatch(/Compensation/i);
  });

  it('excludes hidden inputs', () => {
    expect(excluded({ inputType: 'hidden', name: 'csrf' })).toMatch(/Hidden/i);
  });

  it('reason strings contain no field value (descriptors hold none)', () => {
    const reason = classifyField(d({ labelText: 'Password' })).kind;
    expect(reason).toBe('excluded');
  });
});
