/*
  Who is who, in one place.

  Accounts have one role:
    SUPER_ADMIN      everything, and manages staff
    ADMIN            everything except managing staff
    CONTENT_MANAGER  schools, courses, requirements, exam and deadline events
    COUNSELLOR       staff of a partner secondary school; only the school portal, only their own students
    USER             students (an ambassador is a student with an ambassador profile)
    ANALYST          older accounts only: exports. No longer offered.
*/
export const SUPER_ADMINS = ['SUPER_ADMIN'] as const;
export const ADMINS = ['ADMIN', 'SUPER_ADMIN'] as const;
export const CONTENT_TEAM = ['ADMIN', 'SUPER_ADMIN', 'CONTENT_MANAGER'] as const;
/** Everyone who signs in to the AlignTraits admin panel. */
export const PANEL_STAFF = ['ADMIN', 'SUPER_ADMIN', 'CONTENT_MANAGER', 'ANALYST'] as const;
/** Everyone who signs in on the staff login page: the admin panel plus school counsellors. */
export const STAFF_LOGIN = [...PANEL_STAFF, 'COUNSELLOR'] as const;
/** Roles a super admin can give by invitation or in the team list. */
export const INVITABLE_STAFF = ['SUPER_ADMIN', 'ADMIN', 'CONTENT_MANAGER'] as const;

type WithRole = { role?: string | null } | null | undefined;
const has = (list: readonly string[], user: WithRole) => !!user && list.includes(String(user.role));

export const isSuperAdmin = (user: WithRole) => has(SUPER_ADMINS, user);
export const isAdmin = (user: WithRole) => has(ADMINS, user);
export const isContentTeam = (user: WithRole) => has(CONTENT_TEAM, user);
export const isPanelStaff = (user: WithRole) => has(PANEL_STAFF, user);
export const isStaffLogin = (user: WithRole) => has(STAFF_LOGIN, user);
export const isCounsellor = (user: WithRole) => !!user && user.role === 'COUNSELLOR';

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  CONTENT_MANAGER: 'Content manager',
  ANALYST: 'Analyst',
  COUNSELLOR: 'School counsellor',
  AMBASSADOR: 'Ambassador',
  USER: 'Student',
};
export const roleLabel = (role: string | null | undefined) => ROLE_LABELS[String(role)] || 'Member';
