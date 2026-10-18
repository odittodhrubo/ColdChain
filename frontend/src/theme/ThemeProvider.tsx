import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'coldchain.theme'; // a display preference, not a secret: localStorage is fine here

const ThemeContext = createContext<{ choice: ThemeChoice; dark: boolean; setChoice(c: ThemeChoice): void }>({
  choice: 'system',
  dark: false,
  setChoice: () => undefined,
});

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const systemDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/** System default with a manual override; the class on <html> switches every token at once. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSysDark(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const dark = choice === 'dark' || (choice === 'system' && sysDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const value = useMemo(
    () => ({
      choice,
      dark,
      setChoice(c: ThemeChoice) {
        setChoiceState(c);
        try {
          if (c === 'system') localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, c);
        } catch {
          // storage blocked: the choice lasts for this page view
        }
      },
    }),
    [choice, dark],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
