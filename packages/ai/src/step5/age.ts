/**
 * Whole years of age as of `referenceDate`, computed from a `YYYY-MM-DD`
 * date of birth (already Zod-validated as a real calendar date not in the
 * future — see `packages/domain/src/eligibility.ts`). UTC throughout so a
 * birthday's calendar day never shifts across a local timezone boundary.
 */
export function calculateAgeAt(dateOfBirth: string, referenceDate: Date): number {
  const dob = new Date(`${dateOfBirth}T00:00:00.000Z`);
  let age = referenceDate.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear =
    referenceDate.getUTCMonth() > dob.getUTCMonth() ||
    (referenceDate.getUTCMonth() === dob.getUTCMonth() &&
      referenceDate.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}
