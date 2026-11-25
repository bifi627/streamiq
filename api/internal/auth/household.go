package auth

// Household is one of the user's memberships. In a file of its own: the web app's
// TypeScript is generated from this file alone (scripts/tygo.yaml).
type Household struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
	Role string  `json:"role" tstype:"'admin' | 'member'"`
	// Members counts everyone in the household, the user included.
	Members int `json:"members"`
}
