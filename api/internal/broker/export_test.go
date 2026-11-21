package broker

// Online: whether the broker routes offers to the gateway (tests only).
func (b *Broker) Online(gatewayID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.gateways[gatewayID] != nil
}

// Sessions is how many sessions the broker holds (tests only).
func (b *Broker) Sessions() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.sessions)
}
