import { PROFILE_SCHEMA_VERSION, type Profile } from './profile';
import {
  SENSITIVE_SCHEMA_VERSION,
  type SensitiveProfile,
} from './sensitive';

/**
 * Completely fake sample profiles, used only for development/testing.
 * No real personal data. Names, employers and bullets are obviously fake.
 */
export const sampleProfile: Profile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  displayName: 'Test User',
  headline: 'Fake headline for testing only',
  summary: 'Fake summary written by the fake candidate for development and testing.',
  locationLabel: 'Fake City, FC (Remote)',
  skills: [
    { id: 'skill-1', name: 'Fake Skill A', status: 'claimed' },
    {
      id: 'skill-2',
      name: 'Fake Skill B',
      years: 3,
      status: 'verified',
      evidenceRef: { kind: 'experience', id: 'exp-1', quote: 'Used Fake Skill B daily.' },
    },
  ],
  experience: [
    {
      id: 'exp-1',
      company: 'Acme Fake Co',
      title: 'Fake Job Title',
      location: 'Fake City, FC',
      dates: { start: '2020-03', end: null },
      bullets: [
        'Fake bullet one written by the candidate.',
        'Fake bullet two describing a fake accomplishment.',
      ],
      seniority: 'mid',
    },
  ],
  education: [
    {
      id: 'edu-1',
      institution: 'Fake University',
      credential: 'B.Sc. in Fake Studies',
      fieldOfStudy: 'Fake Studies',
      grade: '3.5 GPA',
      inProgress: false,
      dates: { start: '2016-09', end: '2020-05' },
    },
  ],
  certifications: [
    {
      id: 'cert-1',
      name: 'Fake Certification I',
      issuer: 'Fake Cert Issuer',
      issued: '2022-06-15',
      expires: '2025-06-15',
      credentialUrl: 'https://certificates.example.com/fake-1',
    },
  ],
  projects: [
    {
      id: 'proj-1',
      name: 'Fake Project Alpha',
      description: 'A fake project the fake candidate built for testing.',
      url: 'https://example.com/fake-project-alpha',
      links: ['https://github.com/fake-user/fake-repo'],
      skills: [{ id: 'pskill-1', name: 'Fake Skill A', status: 'claimed' }],
      dates: { start: '2023-01', end: '2023-06' },
    },
  ],
  languages: [{ language: 'English', level: 'native' }],
  portfolio: 'https://portfolio.example.com/fake-user',
  github: 'https://github.com/fake-user',
  linkedin: 'https://www.linkedin.com/in/fake-user',
  preferences: {
    targetTitles: ['Fake Title A', 'Fake Title B'],
    willingToRelocate: false,
    workModes: ['remote'],
    targetLocations: ['Fake City, FC'],
    applicationAnswers: [
      {
        id: 'app-1',
        question: 'Why do you want to work with us?',
        answer: 'Fake answer provided explicitly by the fake candidate.',
      },
    ],
  },
  updatedAt: '2026-10-12T00:00:00.000Z',
};

/** Fake sensitive profile (contact + legal + docs). Never projected into an LLM. */
export const sampleSensitiveProfile: SensitiveProfile = {
  schemaVersion: SENSITIVE_SCHEMA_VERSION,
  contact: {
    firstName: 'Test',
    lastName: 'User',
    email: 'test@example.com',
    phone: '555-0100',
    address: '123 Fake Street, Fake City, FC 00000',
    cityLabel: 'Fake City, FC',
  },
  legal: {
    workAuthorization: 'authorized_no_sponsorship',
    sponsorshipNeeded: false,
  },
  voluntary: {
    gender: 'undisclosed',
    raceEthnicity: ['undisclosed'],
    veteranStatus: 'undisclosed',
    disabilityStatus: 'prefer_not_say',
  },
  documents: {
    compensationExpectation: undefined,
    governmentIdMasked: undefined,
    notesAboutMe: 'Fake note: prefers not to discuss compensation in first contact.',
  },
};
