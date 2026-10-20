import { RotateCw, TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { reportError } from '../lib/errorReport';
import { Button } from './Button';

/**
 * A render crash shows a way out instead of a blank page, and is reported when error tracking is on (D4).
 * Live data keeps flowing on the server; reloading is safe.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; report?: (err: unknown, tags?: Record<string, string>) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    (this.props.report ?? reportError)(err, { kind: 'render' });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="grid min-h-dvh place-items-center bg-ground px-4">
        <div role="alert" className="flex max-w-md flex-col items-start gap-3">
          <p className="flex items-center gap-2 text-base font-semibold text-breach">
            <TriangleAlert aria-hidden className="size-5" />
            This screen stopped working
          </p>
          <p className="text-sm text-ink-2">
            Fridge monitoring and alerts keep running on the server. Reload the page to continue.
          </p>
          <Button icon={<RotateCw aria-hidden className="size-4" />} onClick={() => location.reload()}>
            Reload page
          </Button>
        </div>
      </main>
    );
  }
}
