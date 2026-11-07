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
  /**
   * Returns the user id when the password is correct, otherwise null. `mustChangePassword`: the
   * password is a temporary one an admin set (Cognito: FORCE_CHANGE_PASSWORD after AdminCreateUser).
   */
  verifyPassword(
    email: string,
    password: string,
  ): Promise<{ userId: string; mfaEnabled: boolean; mustChangePassword: boolean } | null>;
  /** The person's own new password replaces a temporary one (Cognito: RespondToAuthChallenge NEW_PASSWORD_REQUIRED). */
  setOwnPassword(userId: string, newPassword: string): Promise<void>;
  /**
   * Generates a new TOTP secret and otpauth:// URI for an authenticator app.
   * Writes nothing: the caller keeps the pending secret until it is confirmed.
   */
  beginTotpEnrollment(userId: string): Promise<{ secret: string; otpauthUrl: string }>;
  /**
   * Saves the secret and enables MFA if the code matches and MFA is still off. First confirmation
   * wins. The code's time step counts as used, so it cannot be replayed to sign in.
   */
  confirmTotpEnrollment(userId: string, secret: string, code: string): Promise<boolean>;
  /**
   * Checks a sign-in code. "replayed": the code is right but its time step was already used
   * successfully for this user (only strictly later steps are accepted).
   */
  verifyTotp(userId: string, code: string): Promise<TotpResult>;
}

export type TotpResult = "ok" | "invalid" | "replayed";
