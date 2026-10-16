// Moved to @drupal-agent-planes/state (eval.ts) so both the state read tools
// and the write tools share one eval transport. Re-exported for compatibility.
export {
  phpPayload,
  parseTrailingJson,
  phpEval,
  shellJoinedEvalArg,
  type EvalOutcome,
} from "@drupal-agent-planes/state";
