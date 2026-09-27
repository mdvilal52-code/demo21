import {
  Permission,
  ROLE_PERMISSIONS,
  type PermissionValue,
  type UserRoleValue,
} from '@ai-concierge/domain';

export interface NavItem {
  href: string;
  label: string;
  /** Permission needed to see the section; `null` means every signed-in staff member. */
  permission: PermissionValue | null;
}

/** Every dashboard section, in display order. The API enforces the same permissions; hiding is only a courtesy. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Home', permission: null },
  { href: '/dashboard/escalations', label: 'Escalations', permission: Permission.ESCALATION_READ },
  { href: '/dashboard/journeys', label: 'Journeys', permission: Permission.JOURNEY_READ },
  { href: '/dashboard/quotes', label: 'Quotes', permission: Permission.JOURNEY_READ },
  { href: '/dashboard/customers', label: 'Customers', permission: Permission.CUSTOMER_READ },
  { href: '/dashboard/fleet', label: 'Fleet', permission: Permission.JOURNEY_READ },
  { href: '/dashboard/audit', label: 'Audit log', permission: Permission.AUDIT_EVENT_READ },
  { href: '/dashboard/security', label: 'Security', permission: Permission.SECURITY_EVENT_READ },
  { href: '/dashboard/settings', label: 'Settings', permission: Permission.JOURNEY_READ },
];

export function hasPermission(role: UserRoleValue, permission: PermissionValue | null): boolean {
  return permission === null || ROLE_PERMISSIONS[role].includes(permission);
}

export function navItemsFor(role: UserRoleValue): NavItem[] {
  return NAV_ITEMS.filter((item) => hasPermission(role, item.permission));
}
