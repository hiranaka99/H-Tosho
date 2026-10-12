import { api } from './api';

/** Load once when the authenticated app opens; all pages share the same picks. */
export const recommendationQuery = {
  queryKey: ['recommendations'] as const,
  queryFn: api.recommendations,
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchInterval: false as const,
  retry: false as const,
  retryOnMount: false,
};
