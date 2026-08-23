import { cache } from 'react';

import { auth } from '@/lib/auth';

/**
 * React invalidates `cache` memoization for every server request. Layouts and
 * pages can therefore share one Auth.js read without retaining session data
 * across users or requests.
 */
export const getRequestSession = cache(async () => auth());
