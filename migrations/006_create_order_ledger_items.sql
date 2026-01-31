-- Order Ledger Items: Line items for each order request
-- Linked to order_ledger, captures what was ordered at submission time
CREATE TABLE IF NOT EXISTS order_ledger_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_ledger_id UUID NOT NULL REFERENCES order_ledger(id),
    product_id UUID NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cents INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for fetching items by ledger entry
CREATE INDEX IF NOT EXISTS idx_order_ledger_items_ledger ON order_ledger_items(order_ledger_id);
