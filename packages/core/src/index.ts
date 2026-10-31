// Public API of @branchguard/core.
// All Git logic lives here. Functions return plain data objects:
// no printing, no prompts, no VS Code APIs.
export {
  diagnose,
  pickNextAction,
  type Diagnosis,
  type NextAction,
  type OperationInProgress,
} from "./diagnose.js";
export { explainDiagnosis, explainRemoteProblem, type Explanation } from "./explain.js";
export { BlockedEnvVarError, NotAGitRepoError } from "./git.js";
export {
  classifyRemoteProblem,
  type RemoteProblem,
  type RemoteProblemKind,
} from "./remote-problem.js";
