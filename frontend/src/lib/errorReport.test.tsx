import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { createErrorReporter, envelopeUrl, scrub } from './errorReport';

// D4: optional error tracking in the browser, scrubbed, and a crash screen instead of a blank page.
describe('error reporting', () => {
  it('scrubs tokens, emails, cookies and secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    expect(scrub(`Bearer x ${jwt} cc_session=${jwt}; a.b@clinic.org ${'f0'.repeat(32)}`)).toBe(
      'Bearer [token] [token] cc_session=[token]; [email] [secret]',
    );
  });

  it('is off without a DSN; with one it sends a scrubbed envelope', () => {
    const send = vi.fn();
    createErrorReporter(undefined, send)(new Error('x'));
    expect(send).not.toHaveBeenCalled();
    createErrorReporter('https://k@sentry.example/9', send)(new Error('failed for admin@coldchain.local'));
    const [url, body] = send.mock.calls[0] as [string, string];
    expect(url).toBe(envelopeUrl('https://k@sentry.example/9'));
    const event = JSON.parse(body.split('\n')[2]);
    expect(event.exception.values[0]).toEqual({ type: 'Error', value: 'failed for [email]' });
  });

  it('a render crash shows the recovery screen and is reported', () => {
    const report = vi.fn();
    const Broken = () => {
      throw new Error('render failed');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React logs the caught error
    render(
      <ErrorBoundary report={report}>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This screen stopped working');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'render failed' }), {
      kind: 'render',
    });
  });
});
