export type ImportFile = {
  path: string;
  kind?: "file" | "symlink";
  size?: number;
};

export type ImportRequest = {
  files: ImportFile[];
  packageJson?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
};

export type ImportFinding = {
  severity: "blocking" | "review" | "info";
  code: string;
  path?: string;
  message: string;
};

export type ImportReport = {
  framework: "vite" | "create-react-app" | "next" | "static" | "unknown";
  canImport: boolean;
  findings: ImportFinding[];
  fileCount: number;
  totalBytes: number;
};

const SECRET_FILE = /(^|\/)(\.env($|\.)|.*\.(pem|key|p12|pfx)|credentials?\.json$|service-account.*\.json$)/i;
const EXAMPLE_ENV = /(^|\/)\.env\.(example|sample|template)$/i;
const BACKEND_PATH = /(^|\/)(api|server|backend|functions|workers?)(\/|$)/i;
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Matches the gateway source-publication limit so an approved import cannot fail on size.
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PROTECTED_PATH = /^(\.git|\.github)(\/|$)/i;

function normalizedPath(path: string): string | null {
  const value = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || value.includes("\0")) return null;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return null;
  return value;
}

function detectFramework(request: ImportRequest, paths: Set<string>): ImportReport["framework"] {
  const all = { ...request.packageJson?.dependencies, ...request.packageJson?.devDependencies };
  if ("next" in all || paths.has("next.config.js") || paths.has("next.config.mjs")) return "next";
  if ("vite" in all || [...paths].some(path => /^vite\.config\.(js|mjs|ts)$/.test(path))) return "vite";
  if ("react-scripts" in all) return "create-react-app";
  if (paths.has("index.html")) return "static";
  return "unknown";
}

export function inspectImport(request: ImportRequest): ImportReport {
  if (!Array.isArray(request.files) || request.files.length === 0) {
    return {
      framework: "unknown",
      canImport: false,
      findings: [{ severity: "blocking", code: "empty_source", message: "No source files were provided." }],
      fileCount: 0,
      totalBytes: 0,
    };
  }

  const findings: ImportFinding[] = [];
  if (request.files.length > MAX_FILES) {
    findings.push({ severity: "blocking", code: "too_many_files", message: `Import inventories may contain at most ${MAX_FILES} files.` });
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of request.files) {
    const path = normalizedPath(file.path);
    if (!path) {
      findings.push({ severity: "blocking", code: "invalid_path", path: file.path, message: "Path is absolute, empty, or traverses outside the source root." });
      continue;
    }
    if (paths.has(path)) {
      findings.push({ severity: "blocking", code: "duplicate_path", path, message: "The source inventory contains this path more than once." });
      continue;
    }
    paths.add(path);
    if (file.kind === "symlink") findings.push({ severity: "blocking", code: "symlink", path, message: "Symlinks are not accepted by hosted import." });
    if (SECRET_FILE.test(path) && !EXAMPLE_ENV.test(path)) findings.push({ severity: "blocking", code: "secret_file", path, message: "Potential secret-bearing files must be removed before import." });
    if (PROTECTED_PATH.test(path)) findings.push({ severity: "blocking", code: "protected_path", path, message: "Repository metadata and workflows are managed by NG Dots and cannot be imported." });
    if (BACKEND_PATH.test(path)) findings.push({ severity: "review", code: "backend_code", path, message: "Server-side code needs an explicit compatibility review." });
    const size = file.size ?? 0;
    if (!Number.isSafeInteger(size) || size < 0) findings.push({ severity: "blocking", code: "invalid_size", path, message: "File size must be a non-negative integer." });
    else {
      totalBytes += size;
      if (size > MAX_FILE_BYTES) findings.push({ severity: "blocking", code: "file_too_large", path, message: "A source file exceeds the 2 MiB hosted-import limit." });
    }
  }

  if (totalBytes > MAX_TOTAL_BYTES) findings.push({ severity: "blocking", code: "source_too_large", message: "The source inventory exceeds the 8 MiB hosted-import limit." });

  const framework = detectFramework(request, paths);
  if (![...paths].some(path => LOCKFILES.has(path.split("/").at(-1)!))) {
    findings.push({ severity: "review", code: "missing_lockfile", message: "No supported dependency lockfile was found." });
  }
  if (framework === "next") findings.push({ severity: "review", code: "next_runtime", message: "Next.js runtime features need compatibility review before import." });
  if (framework === "unknown") findings.push({ severity: "blocking", code: "unsupported_framework", message: "Could not identify a supported frontend project." });

  return {
    framework,
    canImport: !findings.some(finding => finding.severity === "blocking"),
    findings,
    fileCount: paths.size,
    totalBytes,
  };
}
