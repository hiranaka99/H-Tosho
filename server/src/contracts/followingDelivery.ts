export const NOTIFICATION_MODES = ['in-app', 'immediate', 'digest'] as const;
export type NotificationMode = typeof NOTIFICATION_MODES[number];
export const DELIVERY_STATUSES = ['pending', 'dispatching', 'delivered', 'disabled', 'suppressed', 'failed', 'unknown'] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];
export interface DigestSettings { time: string; timezone: string; timezoneFallback: boolean; nextDueAt: string }
export interface NotificationSettings {
  discord: { enabled: boolean; webhookUrl: string };
  revision: number;
  destinationIdentity: string;
  digest: DigestSettings;
}
export interface DeliveryMember {
  eventId: number; source: string; galleryId: string; title: string; url: string | null;
  labels: string[]; watchIds: number[]; originJobIds: number[];
  possibleDuplicate?: boolean;
}
export interface FollowingDelivery {
  id: string; kind: 'immediate' | 'digest'; status: DeliveryStatus; revision: number;
  attempts: number; nextRetryAt: string | null; createdAt: string; startedAt: string | null;
  finishedAt: string | null; error: string | null; receiptId: string | null;
  settingsRevision: number; destinationIdentity: string; batchKey: string | null;
  members: DeliveryMember[]; originJobIds: number[];
}
export interface FollowingDeliveryPage { items: FollowingDelivery[]; total: number; offset: number; limit: number; waitingCount: number }
export interface FollowingDeliverySummary { pending: number; dispatching: number; delivered: number; disabled: number; suppressed: number; failed: number; unknown: number }
export interface DeliveryReview {
  delivery: FollowingDelivery; settingsRevision: number; destinationIdentity: string;
  enabled: boolean; eligibleMembers: DeliveryMember[]; possibleDuplicate: boolean;
  membershipRevision: string;
  approvalId: string;
}
export interface DeliveryRetryRequest {
  expectedRevision: number; settingsRevision: number; destinationIdentity: string;
  approvalId: string; acknowledgeDuplicate: boolean; acknowledgeDestinationChange: boolean;
  membershipRevision: string;
}
