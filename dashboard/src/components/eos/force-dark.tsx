'use client';

import { useEffect } from 'react';
import { useTheme } from 'next-themes';

/**
 * EOS whiteboard is dark-forced (David's ADHD-first design call — dark high-
 * contrast, no light-mode alt for this view). Mounts once, flips the app
 * theme to dark, restores the previous choice on unmount so navigating back
 * to Overview leaves the theme how David likes it there.
 */
export function ForceDark() {
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    const prev = theme;
    setTheme('dark');
    return () => {
      if (prev && prev !== 'dark') setTheme(prev);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
