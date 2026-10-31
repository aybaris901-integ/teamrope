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
export {
  describeStartTaskStep,
  explainDiagnosis,
  explainRemoteProblem,
  explainStartTaskRefusal,
  explainStartTaskResult,
  explainLeftOutFiles,
  explainSavePlan,
  explainSaveRefusal,
  explainSaveResult,
  explainTrackedSecrets,
  explainSyncRefusal,
  explainSyncResult,
  explainTeamStatus,
  timeAgo,
  riskyFileQuestion,
  secretIgnoreQuestion,
  type Explanation,
} from "./explain.js";
export { BlockedEnvVarError, NotAGitRepoError } from "./git.js";
export {
  classifyRemoteProblem,
  type RemoteProblem,
  type RemoteProblemKind,
} from "./remote-problem.js";
export {
  executeStartTask,
  MEMBER_NAME_KEY,
  planStartTask,
  readMemberName,
  slugify,
  type BackupRef,
  type StartTaskOptions,
  type StartTaskPlan,
  type StartTaskRefusal,
  type StartTaskResult,
  type StartTaskStep,
} from "./start-task.js";
export {
  applySaveChoices,
  commitMessageFor,
  executeSave,
  planSave,
  type SaveOptions,
  type SavePlan,
  type SaveRefusal,
  type SaveResult,
  type SaveStep,
} from "./save.js";
export { findRiskyFiles, type ChangedFile, type RiskyFile, type SecretReason } from "./risky-files.js";
export {
  executeSync,
  planSync,
  type DryRunMethod,
  type SyncConflict,
  type SyncOptions,
  type SyncPlan,
  type SyncRefusal,
  type SyncResult,
  type SyncStep,
} from "./sync.js";
export {
  ACTIVE_HOURS,
  FAR_BEHIND_COMMITS,
  STALE_HOURS,
  teamStatus,
  type BranchOverlap,
  type MainConflict,
  type RemoteBranch,
  type TeamProblem,
  type TeamStatus,
  type TeamStatusOptions,
} from "./team-status.js";
