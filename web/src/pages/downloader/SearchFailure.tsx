import { ApiError } from '../../lib/api';
import { Disclosure, ErrorState } from '../../components/ui';

/** Names the problem and the recovery; the raw server message stays one click away. */
export function describeFailure(error: unknown, subject: string): string {
  if (error instanceof ApiError && error.status === 429) return `${subject} is limiting requests right now. Wait a minute, then try again.`;
  if (error instanceof ApiError && error.status >= 500) return `${subject} answered with an error. Try again in a moment.`;
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return `${subject} refused the request. Check your account in Settings, then try again.`;
  return `${subject} could not be reached. Check your connection, then try again.`;
}

export function SearchFailure({ title, subject, error, onRetry }: { title: string; subject: string; error: unknown; onRetry: () => void }) {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex flex-col gap-2">
      <ErrorState title={title} description={describeFailure(error, subject)} onRetry={onRetry} />
      {detail && <Disclosure label="Technical details" className="mx-auto w-full max-w-xl text-xs text-muted"><p className="break-all pt-2">{detail}</p></Disclosure>}
    </div>
  );
}
