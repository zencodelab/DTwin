'use client';

import { useEffect, useState } from 'react';

/**
 * Tracks the active colour scheme.
 *
 * The two ramps are separately chosen sets of steps — one validated against the
 * light surface, one against the dark — so the app must pick between them rather
 * than invert one. Reading the scheme at render time is what makes that choice
 * real instead of a hardcoded `dark = true`.
 */
export function useIsDark(): boolean {
  // Default to dark: this dashboard is for a control room, and it also means the
  // first paint matches the common case rather than flashing the wrong surface.
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');

    const resolve = () => {
      const stamped = document.documentElement.getAttribute('data-theme');
      // An explicit theme stamp wins over the OS setting, both ways.
      setIsDark(stamped === 'dark' || (stamped !== 'light' && query.matches));
    };

    resolve();
    query.addEventListener('change', resolve);

    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });

    return () => {
      query.removeEventListener('change', resolve);
      observer.disconnect();
    };
  }, []);

  return isDark;
}
