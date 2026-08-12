// Shape of the feature-request board, shared by the route that owns the table
// and the two client surfaces that write to it. It lives here rather than in
// the route because a route file may only export route handlers and config:
// a runtime export from one fails the build.

export const FEATURE_REQUEST_STATUSES = ["new", "planned", "shipped", "declined"] as const;
export type FeatureRequestStatus = (typeof FEATURE_REQUEST_STATUSES)[number];

export interface FeatureRequest {
  id: string;
  title: string;
  notes: string | null;
  status: FeatureRequestStatus;
  requester: string | null;
  asked_count: number;
  /** Ticket reference it was filed from, when it came from one. */
  source: string | null;
  created_at: string;
  updated_at: string;
}

export function isFeatureRequestStatus(v: unknown): v is FeatureRequestStatus {
  return typeof v === "string" && (FEATURE_REQUEST_STATUSES as readonly string[]).includes(v);
}
