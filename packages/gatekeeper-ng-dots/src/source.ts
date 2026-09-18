import { inspectImport, type ImportFinding, type ImportReport } from "./import-analysis";

export type SourceFileInput = {
  path: string;
  contentBase64: string;
  mode?: "100644" | "100755";
};

export type VibeAppInput = {
  businessUnit: string;
  slug: string;
  files: SourceFileInput[];
  /** Codes of review-level findings the requester has read and accepts. Blocking findings can never be acknowledged. */
  acknowledgedFindingCodes?: string[];
};

export type PreparedSource = {
  files: Array<{ path: string; contentBase64: string; mode: "100644" | "100755" }>;
  report: ImportReport;
  reviewFindings: ImportFinding[];
  totalBytes: number;
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_PAYLOAD_CHARS = 13_000_000;

export function validateIdentity(input: { slug: string; businessUnit: string }): { slug: string; businessUnit: string } {
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(input.slug)) throw new Error("valid_slug_required");
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(input.businessUnit)) throw new Error("valid_business_unit_required");
  return { slug: input.slug, businessUnit: input.businessUnit };
}

function decodedLength(value: string): number {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64.test(value)) throw new Error("invalid_file_content");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeText(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), character => character.charCodeAt(0)));
}

/**
 * Re-derives every size from the actual content (never from caller-supplied numbers), runs the shared analyzer,
 * and fails closed before anything reaches the approval queue or the gateway.
 */
export function prepareSource(input: VibeAppInput): PreparedSource {
  if (!input || !Array.isArray(input.files)) throw new Error("files_required");
  const seen = new Set<string>();
  let payloadChars = 0;
  const inventory = input.files.map(file => {
    if (!file || typeof file.path !== "string") throw new Error("invalid_file");
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error("duplicate_file_path");
    seen.add(key);
    if (file.mode !== undefined && file.mode !== "100644" && file.mode !== "100755") throw new Error("symlinks_and_special_files_rejected");
    payloadChars += typeof file.contentBase64 === "string" ? file.contentBase64.length : 0;
    if (payloadChars > MAX_PAYLOAD_CHARS) throw new Error("source_too_large");
    return { path: file.path, size: decodedLength(file.contentBase64) };
  });

  const packageFile = input.files.find(file => file.path === "package.json");
  let packageJson: unknown;
  if (packageFile) {
    try { packageJson = JSON.parse(decodeText(packageFile.contentBase64)); } catch { throw new Error("package_json_invalid"); }
    if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) throw new Error("package_json_invalid");
  }

  const report = inspectImport({ files: inventory, packageJson: packageJson as never });
  const blocking = report.findings.filter(finding => finding.severity === "blocking");
  if (blocking.length) throw new Error(`source_blocked: ${[...new Set(blocking.map(finding => finding.code))].join(", ")}`);

  const reviewFindings = report.findings.filter(finding => finding.severity === "review");
  const acknowledged = new Set(input.acknowledgedFindingCodes ?? []);
  const missing = [...new Set(reviewFindings.map(finding => finding.code))].filter(code => !acknowledged.has(code));
  if (missing.length) throw new Error(`review_findings_require_acknowledgement: ${missing.join(", ")}`);

  return {
    files: input.files.map(file => ({ path: file.path, contentBase64: file.contentBase64, mode: file.mode ?? "100644" })),
    report,
    reviewFindings,
    totalBytes: report.totalBytes,
  };
}
