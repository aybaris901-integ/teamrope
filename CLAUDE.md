CLAUDE.md
Project

branchguard (working name, will be renamed) — a VS Code extension + CLI that stops beginner hackathon teams from breaking their Git repo under deadline pressure.

The problem: beginners get lost in branches, commit to main, fear conflicts, and the final merge breaks right before submission. Generic AI advice doesn't help because it can't see the real repo state. This tool can.

Target user: hackathon teams of 3–5 people with mixed skill levels. Key user: the team captain who fixes everything for everyone.

Goal of this sprint: a working MVP in 7 days, tested with real teams. Prefer simple and working over clever and complete.

MVP features (the four buttons)
Command	Behavior
Start task	Check repo access and uncommitted changes, update main, create the member's own branch
Save	Commit and push only to the member's own branch. If they are on main, move their changes to their branch first
Sync	Bring in the latest main. First do a dry-run merge with git merge-tree --write-tree (Git 2.38+); on conflict, warn and list the files instead of merging
Team status	Who is on which branch, who is behind main, whose changes overlap (dry-run merge between branches)

Every action explains what it did and why in one or two plain-English sentences a beginner understands.

Out of scope for the MVP: auto-resolving conflicts, auto-merging into main, a web dashboard, AI commit explanations, a server/backend, a JetBrains plugin, a desktop app.

Architecture

npm workspaces monorepo, TypeScript everywhere.

packages/
  core/     all Git logic (simple-git), no UI code, tested with vitest
  cli/      thin wrapper over core (@inquirer/prompts), mainly for manual testing
  vscode/   VS Code extension, thin UI over core (scaffolded on day 3)
scripts/
  broken-repo.sh   builds ./playground with broken test clones
playground/        generated, git-ignored
Core returns plain data objects. No printing, no prompts, no VS Code APIs in core. Messages for users are built by an explain layer, not inside Git logic.
CLI and extension contain no Git logic of their own — they call core.
No server: team status comes from git fetch and comparing remote branches locally.
Check Git version at runtime. If Git < 2.38, fall back to a dry-run merge in a temporary git worktree.
Git safety rules (non-negotiable)

This tool runs on other people's repos. Losing someone's code is the worst possible bug.

Before any operation that moves, rewrites or discards commits or changes, create a backup ref (e.g. refs/branchguard/backup/<timestamp>) or a stash, and tell the user how to undo.
Never use push --force, reset --hard, branch -D, clean -f or checkout -- . on user work without a backup created first in the same operation.
Never push to main. Never merge into main automatically.
Never touch files outside the repo the user opened.
If the repo is in an unexpected state (mid-merge, mid-rebase, detached HEAD), stop and explain — don't try to fix it.
When in doubt, do less and explain more.
Testing
Every core function gets vitest tests that run against real repos in ./playground (built by scripts/broken-repo.sh), not mocks of Git.
The playground has a bare origin.git (main: Add README, Add app, Add config, Add API URL to config) and these clones:

alice: on alice/feature from latest main, one pushed commit, clean, up to date.
bob: on main with one local commit that was never pushed.
carol: on carol/feature, branched before main's last commit (1 behind), uncommitted edit to src/app.js on the line alice changed.
eve: on eve/feature, clean, but origin points to a missing path, so fetch fails.
frank: on frank/feature, stuck mid-merge of alice/feature with a conflict in src/app.js.

When adding a feature, add the broken state that exercises it.
npm test rebuilds the playground automatically (vitest globalSetup) and runs with a temp HOME, so your global Git config doesn't affect tests. Run bash scripts/broken-repo.sh by hand to inspect the clones.
Commands
npm install
bash scripts/broken-repo.sh   # rebuild test playground
npm test                      # vitest across workspaces (rebuilds playground first)
npm run build

Update this section when scripts change.

Conventions
All code, comments, commit messages, docs and user-facing text in English.
TypeScript strict mode. No any unless commented why.
Small functions, explicit names. Prefer readable over clever.
User-facing text: short, friendly, no Git jargon without a one-line explanation.
Commit messages: imperative, short (Add diagnose(), Handle detached HEAD in sync).
How to work with me
I'm a solo developer on a 7-day sprint. Keep changes small and focused on the current task.
Before a big change, show a short plan and wait for my OK.
After finishing, tell me how to test it manually in one or two steps.
If something in this file looks wrong or blocks good work, say so instead of working around it.
Outputs
Git для хакатон-команд — концепция MVP
Claude Docs