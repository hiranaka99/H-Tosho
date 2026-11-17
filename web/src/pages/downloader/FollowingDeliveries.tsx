import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Bell, Loader2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogTitle, DialogDescription, ErrorState, Select } from '../../components/ui';
import { DELIVERY_STATUSES, type DeliveryReview, type DeliveryRetryRequest } from '../../../../server/src/contracts/followingDelivery';

const STATUS_LABELS = { pending: 'Queued', dispatching: 'Sending · cannot recall', delivered: 'Delivered', disabled: 'Disabled · not sent', suppressed: 'Suppressed · not sent', failed: 'Failed', unknown: 'Unknown · review required' };
export function FollowingDeliveries({ jobId, embedded = false }: { jobId?: number; embedded?: boolean }) {
  const qc = useQueryClient();
  const [status, setStatus] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [reviewId, setReviewId] = React.useState<string | null>(null);
  const [review, setReview] = React.useState<DeliveryReview | null>(null);
  const [reviewLoading, setReviewLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = React.useState(false);
  const [destinationAcknowledged, setDestinationAcknowledged] = React.useState(false);
  const [approval, setApproval] = React.useState<DeliveryRetryRequest | null>(null);
  const reviewTrigger = React.useRef<HTMLButtonElement | null>(null);
  const statusFilter = React.useRef<HTMLSelectElement | null>(null);
  const reviewRequest = React.useRef(0);
  const id = React.useId();
  const query = useQuery({ queryKey: ['following-deliveries', jobId, status, offset], queryFn: () => api.followingDeliveries({ jobId, status, offset, limit: 20 }), refetchInterval: 5_000 });
  async function loadReview(deliveryId: string) {
    const requestId = ++reviewRequest.current;
    setReviewId(deliveryId); setReviewLoading(true); setReview(null); setError('');
    setDuplicateAcknowledged(false); setDestinationAcknowledged(false); setApproval(null);
    try { const result = await api.followingDeliveryReview(deliveryId); if (requestId === reviewRequest.current) setReview(result); }
    catch (failure) { if (requestId === reviewRequest.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (requestId === reviewRequest.current) setReviewLoading(false); }
  }
  async function sendReviewed() {
    if (!review || !reviewId || pending || !destinationAcknowledged || (review.possibleDuplicate && !duplicateAcknowledged)) return;
    const decision = approval ?? { expectedRevision: review.delivery.revision, settingsRevision: review.settingsRevision,
      destinationIdentity: review.destinationIdentity, membershipRevision: review.membershipRevision, approvalId: review.approvalId, acknowledgeDuplicate: duplicateAcknowledged, acknowledgeDestinationChange: destinationAcknowledged };
    setApproval(decision); setPending(true); setError('');
    try {
      await api.retryFollowingDelivery(reviewId, decision);
      setReviewId(null); setReview(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ['following-deliveries'] }), qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: ['job', jobId] })]);
      reviewTrigger.current?.focus();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      if (failure instanceof ApiError && failure.status === 409) { setApproval(null); setReview(null); }
      // On an ambiguous HTTP response retain the SAME approval key for safe repeated submission.
    } finally { setPending(false); }
  }
  const content = <>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="max-w-prose"><p className="text-sm text-muted">Provider checks save finds first. Discord delivery is separate; unknown outcomes wait for explicit duplicate-aware review.</p></div>
      <label className="flex flex-col gap-1 text-xs text-muted">Delivery status<Select ref={statusFilter} aria-label="Delivery status" className="min-h-11 sm:w-56" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="">All delivery statuses</option>{DELIVERY_STATUSES.map(value => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}</Select></label>
    </div>
    {query.isError && <ErrorState title="Could not load delivery history" description={query.error.message} onRetry={() => void query.refetch()} />}
    {query.isPending ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading delivery history…</p> : query.data && <>
      {query.data.waitingCount > 0 && <p role="status" className="text-sm text-muted">{query.data.waitingCount} committed notification {query.data.waitingCount === 1 ? 'intent awaits' : 'intents await'} dispatch or the daily digest cutoff.</p>}
      {!query.data.items.length && <p className="py-4 text-sm text-muted">No {status ? STATUS_LABELS[status as keyof typeof STATUS_LABELS].toLowerCase() : ''} deliveries recorded. First checks seed silently; in-app-only and paused checks do not queue Discord sends.</p>}
      <div className="divide-y divide-border">{query.data.items.map(delivery => <article key={delivery.id} className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{delivery.kind === 'digest' ? 'Daily digest' : 'Immediate notification'} · {delivery.members.length} {delivery.members.length === 1 ? 'gallery' : 'galleries'}</h3><Badge tone={delivery.status === 'delivered' ? 'success' : ['failed', 'unknown'].includes(delivery.status) ? 'warning' : 'muted'}>{STATUS_LABELS[delivery.status]}</Badge></div>
        <p className="break-words text-xs text-muted">Created {new Date(delivery.createdAt).toLocaleString()} · {delivery.attempts} send {delivery.attempts === 1 ? 'attempt' : 'attempts'} · destination {delivery.destinationIdentity ? delivery.destinationIdentity.slice(0, 12) : 'not configured'} · settings revision {delivery.settingsRevision}{delivery.batchKey ? ` · ${delivery.batchKey}` : ''}</p>
        {delivery.members.map(member => <p key={member.eventId} className="break-words text-sm">{member.title}<span className="text-muted">{member.labels.length ? ` · via ${member.labels.join(', ')}` : ' · no active watch labels'}</span></p>)}
        {delivery.error && <p className="break-words text-sm text-warning">{delivery.error}</p>}
        {delivery.nextRetryAt && <p className="text-xs text-muted">Automatic retry: {new Date(delivery.nextRetryAt).toLocaleString()} · same immutable membership.</p>}
        {delivery.receiptId && <p className="text-xs text-muted">Discord acknowledged message {delivery.receiptId}.</p>}
        <div className="flex flex-wrap items-center gap-2">{delivery.originJobIds.map(origin => <Link key={origin} className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4" to={`/jobs?job=${origin}`}>Provider check #{origin}</Link>)}
          {!['pending', 'dispatching'].includes(delivery.status) && !delivery.nextRetryAt && delivery.members.length > 0 && <Button variant="outline" size="sm" className="min-h-11" onClick={event => { reviewTrigger.current = event.currentTarget; void loadReview(delivery.id); }}>{delivery.status === 'unknown' || delivery.status === 'delivered' || delivery.members.some(member => member.possibleDuplicate) ? 'Review resend' : 'Review backlog / retry'}</Button>}
        </div>
      </article>)}</div>
      {query.data.total > 20 && <nav aria-label="Delivery history pages" className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" className="min-h-11" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(value => Math.max(0, value - 20))}>Newer deliveries</Button><p className="text-xs tabular-nums text-muted">{offset + 1}–{Math.min(offset + 20, query.data.total)} of {query.data.total}</p><Button variant="outline" className="min-h-11" disabled={offset + 20 >= query.data.total || query.isFetching} onClick={() => setOffset(value => value + 20)}>Older deliveries</Button></nav>}
    </>}
    <Dialog open={reviewId !== null} onOpenChange={open => { if (!open && !pending) { ++reviewRequest.current; setReviewId(null); setReview(null); reviewTrigger.current?.focus(); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); if (reviewTrigger.current?.isConnected) reviewTrigger.current.focus(); else statusFilter.current?.focus(); }} onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}><DialogTitle>Review notification recovery</DialogTitle><DialogDescription>Nothing sends until you approve this current destination. A send already started cannot be recalled.</DialogDescription>
        <div className="mt-4 flex flex-col gap-3">{reviewLoading && <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading current delivery and destination…</p>}
          {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
          {review && <>
            <p className="break-words text-sm">Current destination identity: {review.destinationIdentity ? review.destinationIdentity.slice(0, 12) : 'not configured'} · settings revision {review.settingsRevision} · {review.enabled ? 'Discord enabled' : 'Discord disabled'}.</p>
            {review.possibleDuplicate && <p role="alert" className="text-sm text-warning">Discord may already have accepted this message. Resending can create a duplicate; there is no external exactly-once guarantee.</p>}
            <h4 className="text-sm font-semibold">Current eligible membership ({review.eligibleMembers.length})</h4>
            {review.eligibleMembers.map(member => <p key={member.eventId} className="break-words text-sm">{member.title} · via {member.labels.join(', ')}</p>)}
            {!review.eligibleMembers.length && <p className="text-sm text-muted">No active contributions remain. Removed, paused or replaced preferences cannot revive old backlog.</p>}
            {!review.enabled && <p className="text-sm text-muted">Configure and enable Discord in Settings, then reload this review.</p>}
            <label htmlFor={`${id}-destination`} className="flex min-h-11 items-start gap-3 py-2 text-sm"><input id={`${id}-destination`} type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-primary" checked={destinationAcknowledged} disabled={pending} onChange={event => { setDestinationAcknowledged(event.target.checked); setApproval(null); }} />I reviewed the current destination and eligible backlog; send only this reviewed membership.</label>
            {review.possibleDuplicate && <label htmlFor={`${id}-duplicate`} className="flex min-h-11 items-start gap-3 py-2 text-sm"><input id={`${id}-duplicate`} type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-primary" checked={duplicateAcknowledged} disabled={pending} onChange={event => { setDuplicateAcknowledged(event.target.checked); setApproval(null); }} />I accept the risk of a duplicate Discord message.</label>}
            <Button className="min-h-11" disabled={pending || !review.enabled || !review.eligibleMembers.length || !destinationAcknowledged || (review.possibleDuplicate && !duplicateAcknowledged)} onClick={() => void sendReviewed()}>{pending && <Loader2 className="h-4 w-4 animate-spin" />} Queue reviewed {review.possibleDuplicate ? 'resend' : 'delivery'}</Button>
          </>}
          <Button variant="outline" className="min-h-11" disabled={pending || reviewLoading} onClick={() => { if (reviewId) void loadReview(reviewId); }}>Reload current review</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
  if (embedded) return <section className="flex flex-col gap-3" aria-label="Following delivery status"><h3 className="text-sm font-semibold">Notification delivery</h3>{content}</section>;
  return <Card><CardHeader><CardTitle as="h2" className="flex items-center gap-2"><Bell className="h-4 w-4" aria-hidden="true" /> Notification delivery</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">{content}</CardContent></Card>;
}
