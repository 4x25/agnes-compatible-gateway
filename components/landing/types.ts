/** Languages available on the public landing page. */
export type Locale = "en" | "zh-CN";

/** The five user-facing workflows backed by the gateway's six API routes. */
export type Workflow = "chat" | "image" | "edit" | "textVideo" | "imageVideo";

export type RequestPhase =
  | "idle"
  | "requesting"
  | "polling"
  | "success"
  | "error"
  | "cancelled";

export interface EndpointDefinition {
  id: Workflow;
  method: "GET" | "POST";
  path: string;
  /** Short labels are intentionally translated separately from explanatory copy. */
  labels: Record<Locale, string>;
}

export interface ResultState {
  phase: RequestPhase;
  status?: number;
  durationMs?: number;
  requestId?: string;
  taskId?: string;
  text?: string;
  raw?: unknown;
  error?: string;
  imageUrls?: string[];
  videoUrl?: string;
  progress?: number;
}

export interface UploadedImage {
  file: File;
  previewUrl: string;
}
