import type { ReactNode } from 'react';
import { PageHeader } from '../layout/AppShell';
import { Panel } from '../ui/Panel';
import { EmptyState } from '../ui/States';

/** A route whose screen is still being built: it says what it will show instead of an empty frame. */
export function PlannedPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <Panel>
        <EmptyState title="This screen is being built">{children}</EmptyState>
      </Panel>
    </>
  );
}
