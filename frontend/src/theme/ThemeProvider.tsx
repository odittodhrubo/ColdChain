import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark';
const KEY = 'coldchain.theme'; // a display preference, not a secret: localStorage is fine here

const ThemeContext = createContext<{ choice: ThemeChoice; dark: boolean; setChoice(c: ThemeChoice): void }>({
  choice: 'dark',
  dark: true,
  setChoice: () => undefined,
});

const systemDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/** Light or dark only. The first visit follows the OS preference, then the choice is a concrete light/dark. */
function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage blocked */
  }
  return systemDark() ? 'dark' : 'light';
}

/** The chosen theme; the class on <html> switches every token at once. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const dark = choice === 'dark';

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
          localStorage.setItem(KEY, c);
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
