#!/usr/bin/env bash
# Builds ./playground: a local bare "origin" and three clones in different
# broken states, for testing TeamRope against real repos.
#
#   playground/origin.git  bare repo, main has a few commits
#   playground/alice       on alice/feature, clean, up to date with main, pushed
#   playground/bob         committed directly on local main, not pushed
#   playground/carol       on carol/feature, behind main, uncommitted changes
#                          in src/app.js that conflict with alice/feature
#   playground/eve         on eve/feature, clean, but origin's URL points to a
#                          missing path, so fetch fails (no access to remote)
#   playground/frank       on frank/feature, stuck mid-merge of alice/feature
#                          with a conflict in src/app.js
#   playground/dave        on main, up to date, with an uncommitted edit
#                          (started coding on main)
#   playground/gina        on gina/feature (pushed), with an edited README.md,
#                          a new .env holding a fake API key and a node_modules/
#   playground/hank        on hank/feature (pushed), branched before main's last
#                          commit; his commit adds a line to src/config.js at the
#                          same spot as main's "Add API URL to config" (by alice)
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

# Only ever delete the playground folder inside this repo: make sure ROOT
# really is the TeamRope repo before touching anything.
refuse() {
  echo "Refusing to delete $PLAYGROUND: $1" >&2
  exit 1
}
[[ -n "$ROOT" ]] || refuse "repo root is empty"
[[ "$ROOT" != "/" ]] || refuse "repo root is /"
[[ "$ROOT" != "$(cd "$HOME" && pwd)" ]] || refuse "repo root is your home folder"
[[ -f "$ROOT/CLAUDE.md" ]] || refuse "$ROOT/CLAUDE.md not found"
[[ -f "$ROOT/scripts/broken-repo.sh" ]] || refuse "$ROOT/scripts/broken-repo.sh not found"
rm -rf "$PLAYGROUND"
mkdir -p "$PLAYGROUND"

# Clone origin into playground/<name> and set a local identity.
clone_as() {
  local name="$1"
  git clone --quiet "$ORIGIN" "$PLAYGROUND/$name"
  git -C "$PLAYGROUND/$name" config user.name "$name"
  git -C "$PLAYGROUND/$name" config user.email "$name@example.com"
}

# Commit all changes in playground/<name> with a message, dated <minutes>
# ago, so the timeline has commits spread over the last hours.
commit_as() {
  local name="$1" message="$2" minutes="$3"
  local date
  date="$(date -u -d "-$minutes minutes" +%Y-%m-%dT%H:%M:%SZ)"
  git -C "$PLAYGROUND/$name" add -A
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" \
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
commit_as seed "Add README" 300

cat > "$PLAYGROUND/seed/src/app.js" <<'EOF'
function greeting() {
  return "Hello";
}

console.log(greeting());
EOF
commit_as seed "Add app" 290

printf 'export const config = {\n  debug: false,\n};\n' > "$PLAYGROUND/seed/src/config.js"
commit_as seed "Add config" 280
git -C "$PLAYGROUND/seed" push --quiet origin main

# --- carol: branches off main now, so she falls behind later ---------------

clone_as carol
git -C "$PLAYGROUND/carol" switch --quiet -c carol/feature
printf 'body { margin: 0; }\n' > "$PLAYGROUND/carol/src/styles.css"
commit_as carol "Add styles" 100
git -C "$PLAYGROUND/carol" push --quiet -u origin carol/feature

# --- hank: changes the same config lines main is about to change -----------

clone_as hank
git -C "$PLAYGROUND/hank" switch --quiet -c hank/feature
printf 'export const config = {\n  debug: false,\n  apiUrl: "https://hank.example.com",\n};\n' \
  > "$PLAYGROUND/hank/src/config.js"
commit_as hank "Point config at hank's server" 95
git -C "$PLAYGROUND/hank" push --quiet -u origin hank/feature

# --- main moves forward (carol and hank are now behind) ---------------------

# Authored by alice, so conflict messages can name a teammate.
git -C "$PLAYGROUND/seed" config user.name alice
git -C "$PLAYGROUND/seed" config user.email alice@example.com
printf 'export const config = {\n  debug: false,\n  apiUrl: "http://localhost:3000",\n};\n' \
  > "$PLAYGROUND/seed/src/config.js"
commit_as seed "Add API URL to config" 80
git -C "$PLAYGROUND/seed" push --quiet origin main

# --- alice: own branch from latest main, clean, pushed ----------------------

clone_as alice
git -C "$PLAYGROUND/alice" switch --quiet -c alice/feature
sed -i 's/return "Hello";/return "Hello, hackers!";/' "$PLAYGROUND/alice/src/app.js"
commit_as alice "Make greeting friendlier" 40
git -C "$PLAYGROUND/alice" push --quiet -u origin alice/feature

# --- bob: committed straight on main, not pushed ----------------------------

clone_as bob
printf '\n## Team\n\nAlice, Bob, Carol\n' >> "$PLAYGROUND/bob/README.md"
commit_as bob "Add team section" 30

# --- eve: own branch, clean, but origin points nowhere (no access) ----------

clone_as eve
git -C "$PLAYGROUND/eve" switch --quiet -c eve/feature
printf '# Notes\n' > "$PLAYGROUND/eve/NOTES.md"
commit_as eve "Add notes" 70
git -C "$PLAYGROUND/eve" push --quiet -u origin eve/feature
git -C "$PLAYGROUND/eve" remote set-url origin "$PLAYGROUND/missing-origin.git"

# --- frank: own branch, stuck in the middle of a conflicting merge ----------

clone_as frank
git -C "$PLAYGROUND/frank" switch --quiet -c frank/feature
sed -i 's/return "Hello";/return "Hey there";/' "$PLAYGROUND/frank/src/app.js"
commit_as frank "Change greeting" 55
git -C "$PLAYGROUND/frank" push --quiet -u origin frank/feature
# Same line as alice/feature, so the merge must stop on a conflict.
if git -C "$PLAYGROUND/frank" merge --no-edit origin/alice/feature >/dev/null; then
  echo "frank: expected a merge conflict, but the merge succeeded" >&2
  exit 1
fi

# --- dave: started coding straight on main, nothing committed ---------------

clone_as dave
printf '\nconsole.log("dave was here");\n' >> "$PLAYGROUND/dave/src/app.js"

# --- gina: own branch, unsaved work mixed with a secret and node_modules ----

clone_as gina
git -C "$PLAYGROUND/gina" switch --quiet -c gina/feature
git -C "$PLAYGROUND/gina" push --quiet -u origin gina/feature
printf '\n## Setup\n\nRun npm install.\n' >> "$PLAYGROUND/gina/README.md"
# Fake key: shaped like a real one so the secret check notices it.
printf 'OPENAI_API_KEY=sk-test-4f8a1b2c3d4e5f6a7b8c9d0e1f2a\n' > "$PLAYGROUND/gina/.env"
mkdir -p "$PLAYGROUND/gina/node_modules/left-pad"
printf 'module.exports = (s) => s;\n' > "$PLAYGROUND/gina/node_modules/left-pad/index.js"
printf '{ "name": "left-pad" }\n' > "$PLAYGROUND/gina/node_modules/left-pad/package.json"

# --- carol: uncommitted change on the same line alice changed ---------------

git -C "$PLAYGROUND/carol" fetch --quiet origin
sed -i 's/return "Hello";/return "Hi team";/' "$PLAYGROUND/carol/src/app.js"
# Changed 15 minutes ago, so "not shared" has a length on the timeline.
touch -d "15 minutes ago" "$PLAYGROUND/carol/src/app.js"

# The seed clone was only used to build origin.
rm -rf "$PLAYGROUND/seed"

echo "Playground ready in $PLAYGROUND"
echo "  alice: alice/feature, clean, up to date"
echo "  bob:   1 unpushed commit on main"
echo "  carol: carol/feature, behind main, uncommitted change conflicting with alice/feature"
echo "  eve:   eve/feature, clean, origin unreachable"
echo "  frank: frank/feature, stuck mid-merge with a conflict in src/app.js"
echo "  dave:  on main, up to date, uncommitted edit in src/app.js"
echo "  gina:  gina/feature, edited README.md, new .env with a fake key, node_modules/"
echo "  hank:  hank/feature, behind main, his pushed commit conflicts with main in src/config.js"
