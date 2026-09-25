import { z } from 'zod';
import { authenticatedUserSchema } from '@ai-concierge/domain';

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  /** Required only when the account has MFA enabled — a first attempt without it gets `details.mfaRequired`. */
  mfaCode: z.string().length(6).regex(/^\d+$/).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authTokenPairSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string(),
  user: authenticatedUserSchema,
});
export type AuthTokenPair = z.infer<typeof authTokenPairSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const mfaEnrollResponseSchema = z.object({
  secret: z.string(),
  enrollmentUri: z.string(),
});
export type MfaEnrollResponse = z.infer<typeof mfaEnrollResponseSchema>;

export const mfaVerifyRequestSchema = z.object({
  code: z.string().length(6).regex(/^\d+$/),
});
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const mfaVerifyResponseSchema = z.object({
  mfaEnabled: z.literal(true),
});
