/** Same rule as the server (backend/src/auth/password.ts): 10–72 characters, three of four classes. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'At least 10 characters';
  if (pw.length > 72) return 'At most 72 characters';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((r) => r.test(pw)).length;
  return classes >= 3 ? null : 'Mix at least three of: lowercase, uppercase, digits, symbols';
}
