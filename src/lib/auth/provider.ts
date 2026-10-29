/**
 * Authentication boundary. LocalAuthProvider (email + password + TOTP) is the
 * v1.0 implementation; a CognitoAuthProvider can replace it at deployment.
 */
export interface AuthProvider {
  createUser(input: {
    email: string;
    name: string;
    password: string;
    totpSecret?: string;
  }): Promise<{ userId: string }>;
  /** Returns the user id when the password is correct, otherwise null. */
  verifyPassword(email: string, password: string): Promise<{ userId: string; mfaEnabled: boolean } | null>;
  /** Starts TOTP enrollment; returns the secret and an otpauth:// URI for an authenticator app. */
  beginTotpEnrollment(userId: string): Promise<{ secret: string; otpauthUrl: string }>;
  /** Confirms enrollment with a first valid code. */
  confirmTotpEnrollment(userId: string, code: string): Promise<boolean>;
  verifyTotp(userId: string, code: string): Promise<boolean>;
}
