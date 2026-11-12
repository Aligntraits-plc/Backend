/*
  What we know about one student, worked out from real data only:
  their UTME score, survey result, and the courses from their last eligibility
  check placed in three tiers (reach, realistic match, safety net).

  The tiers are explainable on purpose. They come from two facts the eligibility
  check already uses: whether the student meets the course requirements, and how
  far their UTME score is from the course cut-off mark. No percentage is invented.
*/
import { db } from '../config/db';

export type Tier = 'reach' | 'realistic' | 'safety';
export const TIERS: Tier[] = ['reach', 'realistic', 'safety'];
export const TIER_LABELS: Record<Tier, string> = { reach: 'Reach', realistic: 'Realistic match', safety: 'Safety net' };

const SAFETY_MARGIN = 20; // this many marks above the cut-off counts as a safety net
const REACH_MARGIN = 20; // up to this many marks below the cut-off counts as a reach

const parseList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw.split(',').map((x) => x.trim()).filter(Boolean);
  }
};

/** The student's UTME (JAMB) total from their academic records, or null. */
export function utmeScoreOf(record: Record<string, unknown> | null | undefined): number | null {
  if (!record) return null;
  for (let i = 1; i <= 10; i++) {
    const type = String(record[`ExamType${i}`] || '').toUpperCase();
    if (type !== 'JAMB' && type !== 'UTME') continue;
    const grades = parseList(record[`ExamType${i}SubGrades`]).map((g) => parseFloat(g));
    if (grades.length === 0 || grades.some((g) => Number.isNaN(g))) continue;
    const total = Math.round(grades.reduce((a, b) => a + b, 0));
    if (total > 0 && total <= 400) return total;
  }
  return null;
}

export function examsOf(record: Record<string, unknown> | null | undefined) {
  const exams: { type: string; subjects: number }[] = [];
  if (!record) return exams;
  for (let i = 1; i <= 10; i++) {
    const type = String(record[`ExamType${i}`] || '').trim();
    if (!type) continue;
    exams.push({ type, subjects: parseList(record[`ExamType${i}Subjects`]).length });
  }
  return exams;
}

export type Match = {
  courseId: string;
  course: string;
  school: string;
  schoolType: string | null;
  place: string;
  eligible: boolean;
  tier: Tier | null;
  reason: string;
  details: string;
  cutOff: number | null;
  margin: number | null;
  yearOneCost: number | null;
  currency: string | null;
};

function placeIn(tier: Tier | null, eligible: boolean, score: number | null, cutOff: number | null) {
  const margin = score !== null && cutOff ? score - cutOff : null;
  if (eligible) {
    if (margin === null) return { tier: 'realistic' as Tier, margin, reason: 'You meet the requirements for this course.' };
    if (margin >= SAFETY_MARGIN) return { tier: 'safety' as Tier, margin, reason: `Your ${score} is ${margin} marks above the cut-off of ${cutOff}.` };
    return {
      tier: 'realistic' as Tier,
      margin,
      reason: margin === 0 ? `Your ${score} is right on the cut-off of ${cutOff}.` : `Your ${score} is ${margin} ${margin === 1 ? 'mark' : 'marks'} above the cut-off of ${cutOff}.`,
    };
  }
  if (margin !== null && margin < 0 && margin >= -REACH_MARGIN) {
    return { tier: 'reach' as Tier, margin, reason: `Your ${score} is ${-margin} ${margin === -1 ? 'mark' : 'marks'} below the cut-off of ${cutOff}.` };
  }
  return { tier, margin, reason: 'You do not meet the requirements for this course yet.' };
}

export async function studentInsights(userId: string) {
  const [career, eligibility, record] = await Promise.all([
    db.careerResult.findUnique({ where: { userId } }),
    db.eligibilityResult.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
    db.academicRecord.findFirst({ where: { userId } }),
  ]);
  const score = utmeScoreOf(record as any);
  const exams = examsOf(record as any);

  const raw = ((eligibility?.results as any[]) || []).filter((r) => r && typeof r === 'object' && r.course && r.university);
  const schoolNames = Array.from(new Set(raw.map((r) => String(r.university))));
  const courses = schoolNames.length
    ? await db.course.findMany({
        where: { title: { in: Array.from(new Set(raw.map((r) => String(r.course)))) }, university: { name: { in: schoolNames } } },
        select: {
          id: true, title: true, price: true, currency: true, acceptanceFee: true, acceptanceFeeCurrency: true, jambCutOffMark: true,
          university: { select: { name: true, schoolType: true, region: true, country: true } },
        },
      })
    : [];

  const matches: Match[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const c = courses.find((x) => x.title === String(r.course) && x.university.name === String(r.university));
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    const eligible = r.eligibility?.status === 'Eligible';
    const cutOff = c.jambCutOffMark && c.jambCutOffMark > 0 ? Math.round(c.jambCutOffMark) : null;
    const placed = placeIn(null, eligible, score, cutOff);
    const sameCurrency = c.currency === c.acceptanceFeeCurrency;
    matches.push({
      courseId: c.id,
      course: c.title,
      school: c.university.name,
      schoolType: c.university.schoolType ? String(c.university.schoolType) : null,
      place: [c.university.region, c.university.country].filter(Boolean).join(', '),
      eligible,
      tier: placed.tier,
      reason: placed.reason,
      details: typeof r.eligibility?.details === 'string' ? r.eligibility.details.slice(0, 600) : '',
      cutOff,
      margin: placed.margin,
      yearOneCost: c.price > 0 ? Math.round(c.price + (sameCurrency ? c.acceptanceFee || 0 : 0)) : null,
      currency: c.price > 0 ? String(c.currency) : null,
    });
  }

  let recommendedCourses: { id: string; title: string }[] = [];
  if (Array.isArray(career?.recommendedCourses)) {
    recommendedCourses = (career!.recommendedCourses as any[])
      .filter((x) => x && typeof x === 'object' && x.title)
      .map((x) => ({ id: String(x.id || ''), title: String(x.title) }))
      .slice(0, 12);
  }

  return {
    utmeScore: score,
    exams,
    surveyDone: !!career,
    careers: (career?.recommendedCareers || []).slice(0, 8),
    careerReason: career?.reasoning ? career.reasoning.slice(0, 1200) : '',
    recommendedCourses,
    resultsAdded: exams.length > 0,
    matchesChecked: !!eligibility,
    matchesCheckedAt: eligibility?.updatedAt ?? null,
    matches,
  };
}

/** The best course in each tier, for cards that show three options. */
export function topByTier(matches: Match[]) {
  const pick = (tier: Tier) => {
    const list = matches.filter((m) => m.tier === tier);
    if (tier === 'reach') return list.sort((a, b) => (b.margin ?? -99) - (a.margin ?? -99))[0] || null;
    return list.sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0))[0] || null;
  };
  return { reach: pick('reach'), realistic: pick('realistic'), safety: pick('safety') };
}
