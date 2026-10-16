// The writes plane: guarded, precondition-checked tools that mutate a site.
// Reads (field defs, entity read-back) live in @drupal-dev-planes/state; the
// entity diff lives in @drupal-dev-planes/verify. This package owns only the
// side-effecting operations and their write preconditions.

export {
  phpPayload,
  parseTrailingJson,
  phpEval,
  shellJoinedEvalArg,
  type EvalOutcome,
} from "./php-eval.js";
export {
  missingRequiredValues,
  STRUCTURAL_BASE_FIELDS,
} from "./fields.js";
export {
  createContent,
  createContentWire,
  deleteContent,
  createContentSnippet,
  deleteContentSnippet,
  normalizeCreateContentResult,
  type CreateContentPayload,
  type CreateContentResult,
} from "./content.js";
export {
  addField,
  createContentType,
  isFieldType,
  nodeTypeExists,
  normalizeAddFieldResult,
  normalizeCreateContentTypeResult,
  type AddFieldPayload,
  type AddFieldResult,
  type CreateContentTypePayload,
  type CreateContentTypeResult,
  type FieldType,
} from "./contenttypes.js";
export {
  installModuleCheck,
  placeBlock,
  readbackDisplayComponent,
  setDisplayComponent,
  setPermissions,
  type InstallModuleCheck,
  type PlaceBlockPayload,
  type PlaceBlockResult,
  type SetDisplayPayload,
  type SetDisplayResult,
  type SetPermissionsPayload,
  type SetPermissionsResult,
} from "./site-builder.js";
