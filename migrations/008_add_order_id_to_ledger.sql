-- Add order_id column to order_ledger for saga tracking
-- This allows the orchestrator to track which order was created for a ledger entry

ALTER TABLE order_ledger ADD COLUMN IF NOT EXISTS order_id UUID;

CREATE INDEX IF NOT EXISTS idx_order_ledger_order_id ON order_ledger(order_id);

COMMENT ON COLUMN order_ledger.order_id IS 'Reference to the order created by saga step 1';
