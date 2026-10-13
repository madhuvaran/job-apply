/**
 * Legacy starter profile (schema v1) shape, kept for migration reads only.
 * The shape mirrors what the original scaffold stored under the `job-profile`
 * key. Never written by current code.
 */

export interface LegacyProfileV1 {
  basics: { firstName: string; lastName: string; email: string; phone: string };
  summary: string;
  skills: string[];
  experience: Array<{
    company: string;
    title: string;
    start: string;
    end: string | null;
    bullets: string[];
  }>;
}
