package host

// GET /streamiq/status's `host` field, types only: scripts/gen-types.sh makes the
// web app's TypeScript from this file.

// Load is the status's `host` field. A field the platform can't measure is nil.
type Load struct {
	CPU    *float64 `json:"cpu,omitempty"` // busy %, 0–100
	Memory *Memory  `json:"memory,omitempty"`
	Disk   *Disk    `json:"disk,omitempty"`
}

// Memory is physical memory in bytes.
type Memory struct {
	Used  uint64 `json:"used"`
	Total uint64 `json:"total"`
}

// Disk is the disk transcodes fill (the smaller of /cache in Jellyfin and the compose folder's drive), in bytes; Free is what non-root may use.
type Disk struct {
	Free  uint64 `json:"free"`
	Total uint64 `json:"total"`
}
