import { describe, expect, it } from 'vitest';
import { hasPermission, navItemsFor } from './dashboardNav';

const labels = (role: Parameters<typeof navItemsFor>[0]) =>
  navItemsFor(role).map((item) => item.label);

describe('role-aware dashboard navigation', () => {
  it('gives every staff tier the operational screens', () => {
    for (const role of ['ADMIN', 'MANAGER', 'OPS_AGENT', 'SECURITY'] as const) {
      expect(labels(role)).toEqual(
        expect.arrayContaining([
          'Home',
          'Escalations',
          'Journeys',
          'Quotes',
          'Customers',
          'Fleet',
          'Settings',
        ]),
      );
    }
  });

  it('hides audit and security screens from an ops agent', () => {
    expect(labels('OPS_AGENT')).not.toContain('Audit log');
    expect(labels('OPS_AGENT')).not.toContain('Security');
  });

  it('shows the audit log to managers but keeps security events for security and admin', () => {
    expect(labels('MANAGER')).toContain('Audit log');
    expect(labels('SECURITY')).toContain('Security');
    expect(labels('ADMIN')).toEqual(expect.arrayContaining(['Audit log', 'Security']));
  });

  it('treats a null permission as open to every signed-in role', () => {
    expect(hasPermission('OPS_AGENT', null)).toBe(true);
  });
});
