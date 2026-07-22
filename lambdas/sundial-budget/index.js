// index.js — deploy entry point for sundial-budget.
//
// deploy.ps1 bundles lambdas/<name>/index.js into a single index.mjs, so this
// thin shim just re-exports the real handler. Keeping handler.js as its own file
// matches the package README and keeps the entry/handler split explicit.
export { handler } from "./handler.js";
