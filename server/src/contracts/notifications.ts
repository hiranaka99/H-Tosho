export interface NotificationSettings {
  discord: { enabled: boolean; webhookUrl: string };
  revision: number;
  destinationIdentity: string;
}
