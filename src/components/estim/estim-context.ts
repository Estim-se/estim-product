import { createContext } from 'react';
import type { createEstimStore } from '@/lib/estim-store';

// Keep context identity separate from refreshable provider components.
export const EstimContext = createContext<ReturnType<typeof createEstimStore> | null>(null);