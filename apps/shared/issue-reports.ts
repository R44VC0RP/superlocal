/** App-owned diagnostics, never SDK mail data or publication authorization. */
export type IssueLog = { time: string; level: "debug" | "log" | "info" | "warn" | "error"; message: string };
export type IssueBuild = { mode: "optimized" | "development" | "unknown"; assets: string[] };
export type IssueFrame = { width: number; height: number; scrollWidth?: number; bodyScrollWidth?: number; scale?: number };
export type IssueCapture = {
  id: string;
  scope?: string;
  prompt: string;
  url: string;
  title: string;
  capturedAt: string;
  updatedAt: string;
  viewport: { width: number; height: number; pixelRatio: number };
  build?: IssueBuild;
  rendering?: IssueFrame[];
};
export type IssueWrite = IssueCapture & { scope: string; revision: number; logs?: IssueLog[] };
export type IssueImage = { contentType: "image/jpeg" | "image/png"; bytes: number; width: number; height: number; sha256: string };
export type IssueSummary = IssueCapture & {
  scope: string;
  revision: number;
  storage: "repo";
  status: "new" | "in-progress" | "needs-review" | "fixed";
  image: IssueImage;
  logCount: number;
  timingCount: number;
};
export type IssueDetail = IssueSummary & { logs: IssueLog[] };
export type IssuePage = { scope: string; items: IssueSummary[]; nextCursor: string | null };

export const ISSUE_LIMITS = {
  screenshotBytes: 8 * 1024 * 1024,
  metadataBytes: 1024 * 1024,
  requestBytes: 10 * 1024 * 1024,
  maxReports: 500,
  totalBytes: 512 * 1024 * 1024,
  pageSize: 25,
  maxPageSize: 50,
  logs: 200,
  logCharacters: 4000,
  promptCharacters: 10000,
  frames: 20,
} as const;
