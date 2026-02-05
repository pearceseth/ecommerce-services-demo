-- Order Ledger: Authoritative record of all order requests
-- Owned by Edge API - this is the durable record created before any processing
CREATE TABLE IF NOT EXISTS order_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_request_id VARCHAR(255) NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    email VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'AWAITING_AUTHORIZATION',
    total_amount_cents INT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_authorization_id VARCHAR(255),
    order_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for orchestrator queries by status
CREATE INDEX IF NOT EXISTS idx_order_ledger_status ON order_ledger(status);

-- Trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_order_ledger_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_ledger_updated_at_trigger ON order_ledger;
CREATE TRIGGER order_ledger_updated_at_trigger
    BEFORE UPDATE ON order_ledger
    FOR EACH ROW
    EXECUTE FUNCTION update_order_ledger_updated_at();
