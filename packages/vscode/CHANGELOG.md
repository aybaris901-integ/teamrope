# Changelog

## 0.1.0

First public release.

- **Start task**, **Share changes**, **Sync** and **Team status**, each with a plan shown first and a plain-English explanation afterwards.
- Share changes moves work started on main to your own branch, and leaves risky files like `.env` and `node_modules` out.
- Sync does a dry run first and changes nothing if main would conflict with your work.
- **You** panel: where you stand in one sentence, the next step as one button, and a timeline of the team's last two hours.
- **Team** view: conflicts with main and overlapping work first, each with Compare and Copy message; then everyone's branches.
- **Activity** view: the latest commits across the team's branches.
- Editor hints: file badges, a note above lines a teammate also changed, and highlighted lines that would conflict with main (`teamrope.editorHints`).
- Status bar summary and a Get started walkthrough, with a captain role.
- Backups under `refs/teamrope/backup/` before any branch is moved. Never pushes to main, never force-pushes.
