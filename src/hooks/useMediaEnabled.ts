'use client';

import { useEffect, useState } from 'react';

import { mediaEnabled } from '@/lib/media';

export function useMediaEnabled() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    setEnabled(mediaEnabled());
  }, []);
  return enabled;
}
