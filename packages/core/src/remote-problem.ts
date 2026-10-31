// Classifies why talking to the remote failed, from Git's stderr.

export type RemoteProblemKind =
  | "auth"
  | "notFoundOrNoAccess"
  | "sshKey"
  | "hostKey"
  | "network"
  | "timeout"
  | "unknown";

export interface RemoteProblem {
  kind: RemoteProblemKind;
  /** The most relevant line of Git's output. */
  detail: string;
}

// Order matters: every SSH failure ends with "Could not read from remote
// repository", so the specific causes must be matched first.
const RULES: Array<{ kind: RemoteProblemKind; pattern: RegExp }> = [
  {
    kind: "hostKey",
    pattern: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i,
  },
  {
    kind: "sshKey",
    pattern: /Permission denied \([^)]*publickey|incorrect passphrase|Load key .*: invalid format/i,
  },
  {
    kind: "network",
    pattern:
      /Could not resolve host|Temporary failure in name resolution|Connection refused|Connection timed out|timed out during banner exchange|Network is unreachable|No route to host|Failed to connect to|Could not connect to server|Connection closed by remote host|Connection reset by peer|Operation timed out/i,
  },
  {
    kind: "auth",
    pattern: /could not read (Username|Password)|Authentication failed|Invalid username or (password|token)|returned error: 401/i,
  },
  {
    kind: "notFoundOrNoAccess",
    pattern:
      /Repository not found|repository '.*' not found|does not appear to be a git repository|Permission to .* denied|returned error: 40[34]/i,
  },
];

function stripPrefix(line: string): string {
  return line.replace(/^(fatal|error|remote|ERROR):\s*/, "");
}

export function classifyRemoteProblem(stderr: string): RemoteProblem {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const { kind, pattern } of RULES) {
    const line = lines.find((l) => pattern.test(l));
    if (line) return { kind, detail: stripPrefix(line) };
  }
  const line = lines.find((l) => l.startsWith("fatal:")) ?? lines[0] ?? "Unknown error.";
  return { kind: "unknown", detail: stripPrefix(line) };
}
