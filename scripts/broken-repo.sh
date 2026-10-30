#!/usr/bin/env bash
# Builds ./playground: a local bare "origin" and three clones in different
# broken states, for testing branchguard against real repos.
#
#   playground/origin.git  bare repo, main has a few commits
#   playground/alice       on alice/feature, clean, up to date with main, pushed
#   playground/bob         committed directly on local main, not pushed
#   playground/carol       on carol/feature, behind main, uncommitted changes
#                          in src/app.js that conflict with alice/feature
#   playground/eve         on eve/feature, clean, but origin's URL points to a
#                          missing path, so fetch fails (no access to remote)
#
# Safe to re-run: deletes ./playground and rebuilds it from scratch.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAYGROUND="$ROOT/playground"
ORIGIN="$PLAYGROUND/origin.git"

# Ignore the developer's global/system Git config (signing, hooks, default
# branch...) so the playground is the same on every machine.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

# Only ever delete the playground folder inside this repo.
if [[ "$PLAYGROUND" != "$ROOT/playground" || -z "$ROOT" ]]; then
  echo "Refusing to delete unexpected path: $PLAYGROUND" >&2
  exit 1
fi
rm -rf "$PLAYGROUND"
mkdir -p "$PLAYGROUND"

# Clone origin into playground/<name> and set a local identity.
clone_as() {
  local name="$1"
  git clone --quiet "$ORIGIN" "$PLAYGROUND/$name"
  git -C "$PLAYGROUND/$name" config user.name "$name"
  git -C "$PLAYGROUND/$name" config user.email "$name@example.com"
}

# Commit all changes in playground/<name> with a message.
commit_as() {
  local name="$1" message="$2"
  git -C "$PLAYGROUND/$name" add -A
  git -C "$PLAYGROUND/$name" commit --quiet -m "$message"
}

# --- origin with a few commits on main -------------------------------------

git init --quiet --bare --initial-branch=main "$ORIGIN"

# Origin is still empty, so init the seed repo instead of cloning it.
git init --quiet --initial-branch=main "$PLAYGROUND/seed"
git -C "$PLAYGROUND/seed" remote add origin "$ORIGIN"
git -C "$PLAYGROUND/seed" config user.name seed
git -C "$PLAYGROUND/seed" config user.email seed@example.com
mkdir -p "$PLAYGROUND/seed/src"
printf '# Hackathon project\n' > "$PLAYGROUND/seed/README.md"
commit_as seed "Add README"

cat > "$PLAYGROUND/seed/src/app.js" <<'EOF'
function greeting() {
  return "Hello";
}

console.log(greeting());
EOF
commit_as seed "Add app"

printf 'export const config = {\n  debug: false,\n};\n' > "$PLAYGROUND/seed/src/config.js"
commit_as seed "Add config"
git -C "$PLAYGROUND/seed" push --quiet origin main

# --- carol: branches off main now, so she falls behind later ---------------

clone_as carol
git -C "$PLAYGROUND/carol" switch --quiet -c carol/feature
printf 'body { margin: 0; }\n' > "$PLAYGROUND/carol/src/styles.css"
commit_as carol "Add styles"
git -C "$PLAYGROUND/carol" push --quiet -u origin carol/feature

# --- main moves forward (carol is now behind) -------------------------------

printf 'export const config = {\n  debug: false,\n  apiUrl: "http://localhost:3000",\n};\n' \
  > "$PLAYGROUND/seed/src/config.js"
commit_as seed "Add API URL to config"
git -C "$PLAYGROUND/seed" push --quiet origin main

# --- alice: own branch from latest main, clean, pushed ----------------------

clone_as alice
git -C "$PLAYGROUND/alice" switch --quiet -c alice/feature
sed -i 's/return "Hello";/return "Hello, hackers!";/' "$PLAYGROUND/alice/src/app.js"
commit_as alice "Make greeting friendlier"
git -C "$PLAYGROUND/alice" push --quiet -u origin alice/feature

# --- bob: committed straight on main, not pushed ----------------------------

clone_as bob
printf '\n## Team\n\nAlice, Bob, Carol\n' >> "$PLAYGROUND/bob/README.md"
commit_as bob "Add team section"

# --- eve: own branch, clean, but origin points nowhere (no access) ----------

clone_as eve
git -C "$PLAYGROUND/eve" switch --quiet -c eve/feature
printf '# Notes\n' > "$PLAYGROUND/eve/NOTES.md"
commit_as eve "Add notes"
git -C "$PLAYGROUND/eve" push --quiet -u origin eve/feature
git -C "$PLAYGROUND/eve" remote set-url origin "$PLAYGROUND/missing-origin.git"

# --- carol: uncommitted change on the same line alice changed ---------------

git -C "$PLAYGROUND/carol" fetch --quiet origin
sed -i 's/return "Hello";/return "Hi team";/' "$PLAYGROUND/carol/src/app.js"

# The seed clone was only used to build origin.
rm -rf "$PLAYGROUND/seed"

echo "Playground ready in $PLAYGROUND"
echo "  alice: alice/feature, clean, up to date"
echo "  bob:   1 unpushed commit on main"
echo "  carol: carol/feature, behind main, uncommitted change conflicting with alice/feature"
echo "  eve:   eve/feature, clean, origin unreachable"
