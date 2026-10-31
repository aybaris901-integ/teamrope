# branchguard

Keeps hackathon teams from breaking their Git repo under deadline pressure.

Open the **branchguard** icon in the activity bar:

- **You**: where you stand, and the one thing to do next.
- **Actions**: Start task, Save, Sync, Team status.
- **Team**: problems for the captain (conflicts, overlapping work, people who haven't saved in a while) and a table of everyone's branches.

Every action shows its plan in plain English before it changes anything, makes a backup before it moves a branch, never pushes to main and never force-pushes.

Uploads and downloads go through VS Code's own Git, so if you signed in to GitHub in VS Code, branchguard can use that sign-in.

This is a thin UI over `@branchguard/core`; all Git logic lives there.
