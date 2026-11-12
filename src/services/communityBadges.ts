/*
  The tag shown next to someone's name in Community:
    AlignTraits (gold)  admins, super admins and content managers
    AlignTraits (blue)  ambassadors (students who help AlignTraits)
    School name         school counsellors, with a school icon
  Everyone else is a student and has no tag.
*/
import { db } from '../config/db';

export type Badge = { kind: 'team' | 'ambassador' | 'counsellor'; label: string } | null;

const TEAM_ROLES = ['ADMIN', 'SUPER_ADMIN', 'CONTENT_MANAGER'];

export async function badgesFor(users: { id: string; role?: string | null }[]): Promise<Map<string, Badge>> {
  const map = new Map<string, Badge>();
  const students: string[] = [];
  const counsellors: string[] = [];
  for (const u of users) {
    if (map.has(u.id)) continue;
    if (TEAM_ROLES.includes(String(u.role))) map.set(u.id, { kind: 'team', label: 'AlignTraits' });
    else if (u.role === 'COUNSELLOR') counsellors.push(u.id);
    else students.push(u.id);
    if (!map.has(u.id)) map.set(u.id, null);
  }
  const [ambassadors, staff] = await Promise.all([
    students.length
      ? db.ambassadorProfile.findMany({ where: { userId: { in: students }, active: true }, select: { userId: true } }).catch(() => [])
      : [],
    counsellors.length
      ? db.partnerSchoolStaff
          .findMany({ where: { userId: { in: counsellors } }, select: { userId: true, school: { select: { name: true } } } })
          .catch(() => [])
      : [],
  ]);
  for (const a of ambassadors) map.set(a.userId, { kind: 'ambassador', label: 'AlignTraits' });
  for (const c of staff) map.set(c.userId, { kind: 'counsellor', label: c.school.name });
  return map;
}

export async function badgeOf(user: { id: string; role?: string | null }) {
  return (await badgesFor([user])).get(user.id) ?? null;
}
