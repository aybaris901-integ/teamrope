import { describe, expect, test } from "vitest";
import { classifyRemoteProblem, type RemoteProblemKind } from "./remote-problem.js";

const SSH_TAIL = `fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.`;

// Real `git fetch` stderr (Git 2.56, OpenSSH 10.6), except where noted.
const SAMPLES: Array<[string, RemoteProblemKind, string, string]> = [
  [
    "HTTPS, no saved login",
    "auth",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "could not read Username for 'https://github.com': terminal prompts disabled",
  ],
  [
    "HTTPS, wrong login",
    "auth",
    "fatal: Authentication failed for 'https://github.com/team/app.git/'",
    "Authentication failed for 'https://github.com/team/app.git/'",
  ],
  [
    "GitHub HTTPS, repo missing or private",
    "notFoundOrNoAccess",
    "remote: Repository not found.\nfatal: repository 'https://github.com/team/app.git/' not found",
    "Repository not found.",
  ],
  [
    // GitHub's message when logged in without access to the repo.
    "GitHub HTTPS, no permission",
    "notFoundOrNoAccess",
    "remote: Permission to team/app.git denied to alice.\nfatal: unable to access 'https://github.com/team/app.git/': The requested URL returned error: 403",
    "Permission to team/app.git denied to alice.",
  ],
  [
    "local path that doesn't exist",
    "notFoundOrNoAccess",
    `fatal: '/home/me/missing-origin.git' does not appear to be a git repository\n${SSH_TAIL}`,
    "'/home/me/missing-origin.git' does not appear to be a git repository",
  ],
  [
    "SSH key not accepted",
    "sshKey",
    `git@github.com: Permission denied (publickey).\n${SSH_TAIL}`,
    "git@github.com: Permission denied (publickey).",
  ],
  [
    "unknown SSH host",
    "hostKey",
    `No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.\n${SSH_TAIL}`,
    "Host key verification failed.",
  ],
  [
    "SSH host not found",
    "network",
    `ssh: Could not resolve hostname githb.com: Name or service not known\n${SSH_TAIL}`,
    "ssh: Could not resolve hostname githb.com: Name or service not known",
  ],
  [
    "SSH connection refused",
    "network",
    `ssh: connect to host 127.0.0.1 port 1: Connection refused\n${SSH_TAIL}`,
    "ssh: connect to host 127.0.0.1 port 1: Connection refused",
  ],
  [
    "SSH server never answers",
    "network",
    `Connection timed out during banner exchange\nConnection to 127.0.0.1 port 2299 timed out\n${SSH_TAIL}`,
    "Connection timed out during banner exchange",
  ],
  [
    "HTTPS host not found",
    "network",
    "fatal: unable to access 'https://githb.com/team/app.git/': Could not resolve host: githb.com",
    "unable to access 'https://githb.com/team/app.git/': Could not resolve host: githb.com",
  ],
  [
    "HTTPS connection refused",
    "network",
    "fatal: unable to access 'https://127.0.0.1:1/r.git/': Failed to connect to 127.0.0.1:1 after 0 ms: Could not connect to server",
    "unable to access 'https://127.0.0.1:1/r.git/': Failed to connect to 127.0.0.1:1 after 0 ms: Could not connect to server",
  ],
  [
    "something else",
    "unknown",
    "fatal: the remote end hung up unexpectedly",
    "the remote end hung up unexpectedly",
  ],
];

describe("classifyRemoteProblem", () => {
  test.each(SAMPLES)("%s -> %s", (_name, kind, stderr, detail) => {
    expect(classifyRemoteProblem(stderr)).toEqual({ kind, detail });
  });

  test("empty stderr is unknown", () => {
    expect(classifyRemoteProblem("")).toEqual({ kind: "unknown", detail: "Unknown error." });
  });
});
