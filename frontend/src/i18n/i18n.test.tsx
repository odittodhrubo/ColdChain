import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider, useT } from './index';
import { LanguageToggle } from './LanguageToggle';

function Probe() {
  const { t } = useT();
  return <p>{t('nav.dashboard')}</p>;
}

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('language toggle (P6)', () => {
  it('switches every consumer between English and Bangla on click', async () => {
    render(
      <LanguageProvider>
        <LanguageToggle />
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    // the button offers the other language
    await userEvent.click(screen.getByRole('button', { name: /switch to বাংলা/i }));
    expect(screen.getByText('ড্যাশবোর্ড')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    // and back
    await userEvent.click(screen.getByRole('button', { name: /switch to english/i }));
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('remembers the choice in localStorage', async () => {
    const { unmount } = render(
      <LanguageProvider>
        <LanguageToggle />
        <Probe />
      </LanguageProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /switch to বাংলা/i }));
    unmount();
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByText('ড্যাশবোর্ড')).toBeInTheDocument();
  });
});
