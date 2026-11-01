# branchguard

Keeps hackathon teams from breaking their Git repo under deadline pressure.

Open the **branchguard** icon in the activity bar:

- **You**: one sentence about where you stand, one button for the next step (Start task, Share changes or Sync), and who else is changing the same code as you, with Compare and Copy message.
- **Team**: problems for the captain (conflicts, overlapping work, people who haven't shared in a while), then everyone on the team with their status.
- **Activity**: the latest commits across the team's branches.

The status bar shows the short version: "1 to share", "Next: Sync", "In sync", or "Conflict in <file>".

Every action shows its plan in plain English before it changes anything, makes a backup before it moves a branch, never pushes to main and never force-pushes.

Uploads and downloads go through VS Code's own Git, so if you signed in to GitHub in VS Code, branchguard can use that sign-in.

This is a thin UI over `@branchguard/core`; all Git logic lives there.
