/**
 * Tests for normalization + conservative vocabulary (matching/vocabulary.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalizeCertification,
  canonicalizeSkill,
  containsPhrase,
  displayLabel,
  educationLevelFromText,
  educationLevelLabel,
  educationLevelRank,
  findSkillMentions,
  isStrictTokenPrefix,
  normalizeForMatch,
  SKILL_VOCABULARY,
  titleTokens,
  tokens,
} from './vocabulary';

describe('normalizeForMatch', () => {
  it('lowercases, strips diacritics, collapses whitespace and punctuation', () => {
    expect(normalizeForMatch('  Réact   JS!! ')).toBe('react js');
    expect(normalizeForMatch('Node.js\nDeveloper')).toBe('node.js developer');
  });

  it('keeps # + . so c#, c++ and node.js survive normalization', () => {
    expect(normalizeForMatch('C# and C++ and .NET')).toBe('c# and c++ and .net');
  });

  it('tokens() splits and drops empties', () => {
    expect(tokens('a  b-c')).toEqual(['a', 'b', 'c']);
    expect(tokens('   ')).toEqual([]);
  });
});

describe('skill canonicalization (conservative aliases only)', () => {
  it('accepts defensible aliases', () => {
    expect(canonicalizeSkill('k8s')).toBe('kubernetes');
    expect(canonicalizeSkill('Node.JS')).toBe('node');
    expect(canonicalizeSkill('postgres')).toBe('postgresql');
    expect(canonicalizeSkill('JavaScript')).toBe('javascript');
    expect(canonicalizeSkill('c#')).toBe('csharp');
    expect(canonicalizeSkill('Golang')).toBe('go');
  });

  it('never matches inside another word (word boundaries)', () => {
    expect(canonicalizeSkill('javascript')).not.toBe('java');
    expect(findSkillMentions('javascript')).toEqual(['javascript']);
    expect(findSkillMentions('asp.net')).toEqual([]); // .net must not match inside asp.net
  });

  it('longest alias wins: "node.js" resolves to node, not to js', () => {
    expect(findSkillMentions('experience with node.js')).toEqual(['node']);
  });

  it('unknown skills are never guessed into the vocabulary', () => {
    expect(canonicalizeSkill('SAP HANA custom module')).toBeNull();
    expect(canonicalizeSkill('teamwork')).toBeNull();
  });

  it('ambiguous prose words are deliberately NOT aliases', () => {
    // "spring" alone must not resolve to spring-boot; "rest" and "express" are not aliases.
    expect(canonicalizeSkill('spring')).toBeNull();
    expect(canonicalizeSkill('rest')).toBeNull();
    expect(canonicalizeSkill('express')).toBeNull();
    expect(canonicalizeSkill('Spring Boot')).toBe('spring-boot');
  });

  it('multi-skill lines return distinct mentions', () => {
    expect(findSkillMentions('React, Kubernetes and PostgreSQL')).toEqual(
      expect.arrayContaining(['react', 'kubernetes', 'postgresql']),
    );
  });

  it('the vocabulary is unique and non-empty (stable ids)', () => {
    const ids = SKILL_VOCABULARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(30);
  });
});

describe('containsPhrase / prefix rules', () => {
  it('matches whole words only', () => {
    expect(containsPhrase('deep java experience', 'java')).toBe(true);
    expect(containsPhrase('javascript experience', 'java')).toBe(false);
    expect(containsPhrase('reactive systems', 'react')).toBe(false);
  });

  it('isStrictTokenPrefix only fires across real token boundaries', () => {
    expect(isStrictTokenPrefix('React Native', 'React')).toBe(true);
    expect(isStrictTokenPrefix('JavaScript', 'Java')).toBe(false);
    expect(isStrictTokenPrefix('React', 'React')).toBe(false);
  });
});

describe('education + title helpers', () => {
  it('detects the highest level mentioned, conservatively', () => {
    expect(educationLevelFromText("Master's degree required")).toBe('master');
    expect(educationLevelFromText('Ph.D. preferred')).toBe('doctorate');
    expect(educationLevelFromText('B.Sc. in something')).toBe('bachelor');
    expect(educationLevelFromText('A degree is required')).toBe('degree');
    expect(educationLevelFromText('no formal education mentioned')).toBeNull();
  });

  it('ranks and labels levels deterministically', () => {
    expect(educationLevelRank('doctorate')).toBeGreaterThan(educationLevelRank('master'));
    expect(educationLevelRank('master')).toBeGreaterThan(educationLevelRank('bachelor'));
    expect(educationLevelRank('bachelor')).toBeGreaterThan(educationLevelRank('degree'));
    expect(educationLevelLabel('master')).toBe("Master's degree");
  });

  it('titleTokens drop level words', () => {
    expect(titleTokens('Senior Backend Engineer')).toEqual(['backend', 'engineer']);
    expect(titleTokens('Staff Software Engineer II')).toEqual(['software', 'engineer']);
  });

  it('displayLabel bounds length with an ellipsis', () => {
    expect(displayLabel('short', 20)).toBe('short');
    expect(displayLabel('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('certifications', () => {
  it('resolves only named certifications in the vocabulary', () => {
    expect(canonicalizeCertification('Current PMP certification')).toBe('pmp');
    expect(canonicalizeCertification('CKA required')).toBe('cka');
    expect(canonicalizeCertification('Some local certificate')).toBeNull();
  });
});
