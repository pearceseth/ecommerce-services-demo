-- Orders table: main order record
-- Links to order_ledger via order_ledger_id for saga traceability
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_ledger_id UUID NOT NULL UNIQUE,  -- Links to Edge API's order_ledger
    user_id UUID NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    total_amount_cents INT NOT NULL,       -- Stored in cents (e.g., 9999 = $99.99)
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_ledger_id ON orders(order_ledger_id);

-- Order items table: line items for each order
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL,              -- References inventory service's products
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cents INT NOT NULL,         -- Stored in cents
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for fetching items by order
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at_trigger ON orders;
CREATE TRIGGER orders_updated_at_trigger
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION update_orders_updated_at();

-- Comment on status values for documentation
COMMENT ON COLUMN orders.status IS 'Order status: CREATED, CONFIRMED, CANCELLED';
COMMENT ON COLUMN orders.total_amount_cents IS 'Total in cents (e.g., 9999 = $99.99)';
COMMENT ON COLUMN order_items.unit_price_cents IS 'Price per unit in cents';
