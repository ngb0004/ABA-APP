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
  /**
   * Generates a new TOTP secret and otpauth:// URI for an authenticator app.
   * Writes nothing: the caller keeps the pending secret until it is confirmed.
   */
  beginTotpEnrollment(userId: string): Promise<{ secret: string; otpauthUrl: string }>;
  /** Saves the secret and enables MFA if the code matches and MFA is still off. First confirmation wins. */
  confirmTotpEnrollment(userId: string, secret: string, code: string): Promise<boolean>;
  verifyTotp(userId: string, code: string): Promise<boolean>;
}
