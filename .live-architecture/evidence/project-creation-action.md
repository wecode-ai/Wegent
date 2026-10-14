# Single-option project creation

- Transaction: tx-84f9a18c0c39; base A00000008.
- Human intent: a project-create control must act directly when only one creation method exists; dropdown arrows and menus are reserved for multiple methods.
- Affected stable IDs: arch://wegent/ui/617dc728 and arch://wegent/test/546c88a4. Read shared UI arch://wegent/ui/287398da.
- State: implemented and statically/test verified; not deployed or real-Electron confirmed.

The extracted ProjectCreationAction derives the available command list and renders a native button when its length is one. The button retains its existing label, plus icon, dimensions and trigger selector, has no dropdown arrow or menu semantics, and invokes the existing blank-project command. Multiple commands still use the shared ActionMenu and preserve the blank/folder/existing callbacks and selectors. The same component is used by workspace header, workspace empty-state and global first-project entry. Workspace ownership choice and submission still belong to the existing controller and dialog.

Verification:

- Shared action component and full collaboration platform test files: 122 tests passed (9 action cases and 113 platform cases).
- Tests cover absence of arrow/menu for all three direct entry selectors, both workspace controls opening the actual cloud project form, all three local modes from header and starter, existing ownership selection, permissions, creation persistence and import flows.
- Shared package build, Wework typecheck and frontend TypeScript check passed.
- ESLint inspected the new component/tests and seven changed E2E helper/scenario files: nine files passed with no ignored files.
- Prettier and scoped whitespace checks passed. Node syntax checks passed for the E2E helper and six scenario consumers.

The first test run exposed an overly broad new helper assertion that assumed every blank-project action immediately opens a form. Existing multi-workspace entry flows correctly open an ownership chooser first. The helper now performs only the supported action selection; the original workspace-selection assertions and the new direct cloud-form assertions remain intact. No permission or security assertion was removed or relaxed.

Six existing CI-covered cloud creation scenarios now use openDirectProjectCreation, which asserts there is no menu-style trigger, opens the real creation dialog and asserts no intermediate menu appears. Local folder/import and local multi-option group onboarding retain their existing dropdown steps. No standalone E2E entrypoint was added. E2E and ai:verify were not executed under the repository policy.

Other existing working-tree edits, including concurrent notification and permission work, were preserved. No API, schema, permission contract, locale or execution behavior changed.
