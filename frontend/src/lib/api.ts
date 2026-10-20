import { session } from '../auth/session';

/** Every failure as one shape: HTTP status (0 = network), the server's error code and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: ((err: ApiError) => void) | null = null;
/** The auth provider registers this: any 401 on an authenticated call ends the session. */
export function setUnauthorizedHandler(fn: ((err: ApiError) => void) | null) {
  onUnauthorized = fn;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal; // TanStack Query passes one: leaving a page cancels its requests
  auth?: boolean; // default true
}

/** Typed fetch wrapper: JSON in and out, the session cookie (same origin), normalised errors. */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, auth = true } = opts;
  const signedIn = auth && session.get() !== null;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal,
      credentials: 'same-origin', // the HttpOnly session cookie; the browser adds Origin, which the server checks
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'The server did not answer');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  if (!res.ok) {
    const err = new ApiError(
      res.status,
      data?.error?.code ?? `HTTP_${res.status}`,
      data?.error?.message ?? res.statusText ?? 'Request failed',
      data?.error?.details,
    );
    if (res.status === 401 && signedIn) onUnauthorized?.(err);
    throw err;
  }
  return data as T;
}

/** Retry policy: never retry a 4xx (it will not change), retry network and 5xx twice. */
export function shouldRetry(failures: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
  return failures < 2;
}
