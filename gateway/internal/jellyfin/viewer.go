package jellyfin

// GET /streamiq/status's `viewer` field (ViewerState), types only:
// scripts/gen-types.sh makes the web app's TypeScript from this file.

// ViewerStatus is whether the calling session plays as the shared viewer and, if so,
// why (a code the web app words, frontend/src/features/library/guest.ts).
type ViewerStatus struct {
	Reason string `json:"reason,omitempty"`
	Shared bool   `json:"shared"`
}
