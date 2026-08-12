// Fix round 1, IMPORTANT: static proof that GateInput.actionKind cannot be
// satisfied by a bare string. This file (not named `*.test.ts`) is picked
// up by `tsc --build` the same as any other source file in this package --
// packages/policy/tsconfig.json excludes only `src/**/*.test.ts` -- so this
// check runs as part of `npm run typecheck`/`npm run verify`, not only when
// someone happens to run tsc over the test suite by hand. It has no runtime
// behaviour and is never imported by anything; its only job is to fail the
// build if the type contract it asserts ever weakens.
import type { GateInput } from "./approval-policy.ts";

// @ts-expect-error -- TrustedActionKind can only be produced by
// trustActionKind(), which checks the value against the caller's real tool
// allowlist. A bare string literal must never satisfy GateInput.actionKind:
// if this stops being a type error, a future caller can once again pipe
// unvetted, model-parsed text straight into the approval gate with no
// allowlist check at all (the wiring risk fix round 1 closes).
const _unsafeGateInput: GateInput = { actionKind: "publish_social", text: "x", qaVerdict: "pass" };
void _unsafeGateInput;
