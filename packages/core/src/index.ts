export type * from "./types.js";
export { Engine } from "./engine.js";
export { NS_SEP, InvalidQualifiedNameError } from "./resolve.js";
export type { EngineOptions } from "./engine.js";
export { asAsync, createEngine } from "./create-engine.js";
export type { CreateEngineOptions } from "./create-engine.js";
export type { AsyncSymbolEngine, SymbolEngine } from "./symbol-engine.js";
export {
	renderFileOutline,
	renderReferences,
	renderHandles,
	renderCandidates,
	renderResolve,
	renderSource,
	renderRegion,
	renderMembers,
	renderStatements,
	renderCallHierarchy,
	renderContext,
	renderImports,
	renderUsageReport
} from "./render.js";
export { planRename, isValidIdentifier } from "./edit/rename.js";
export type { RenameRequest } from "./edit/rename.js";
export { applyEditPlan } from "./edit/apply.js";
export type { ApplyOptions, EditResult, ChangedFile } from "./edit/apply.js";
export { EditConflictError, EditRefusedError } from "./edit/errors.js";
export { contentHash, normalizeWorkspaceEdit, applyTextEdits } from "./edit/plan.js";
export type { EditPlan, FileEdits, FileMove, TextEdit, LspRange, LspPosition, WorkspaceEdit } from "./edit/plan.js";
