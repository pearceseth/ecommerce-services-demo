#!/bin/bash
set -e

# Run migrations via docker-compose exec
MIGRATIONS_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Running migrations from $MIGRATIONS_DIR"

# Create migrations tracking table if it doesn't exist
docker-compose -f "$PROJECT_DIR/docker-compose.yml" exec -T postgres psql -U ecommerce -d ecommerce -q <<EOF
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
EOF

# Run each migration file in order
for migration in "$MIGRATIONS_DIR"/*.sql; do
    filename=$(basename "$migration")

    # Check if migration has already been applied
    applied=$(docker-compose -f "$PROJECT_DIR/docker-compose.yml" exec -T postgres \
        psql -U ecommerce -d ecommerce -tAc \
        "SELECT COUNT(*) FROM schema_migrations WHERE filename = '$filename'")

    # Trim whitespace
    applied=$(echo "$applied" | tr -d '[:space:]')

    if [ "$applied" = "0" ]; then
        echo "Applying migration: $filename"
        docker-compose -f "$PROJECT_DIR/docker-compose.yml" exec -T postgres \
            psql -U ecommerce -d ecommerce -f - < "$migration"
        docker-compose -f "$PROJECT_DIR/docker-compose.yml" exec -T postgres \
            psql -U ecommerce -d ecommerce -q <<EOF
INSERT INTO schema_migrations (filename) VALUES ('$filename');
EOF
        echo "Applied: $filename"
    else
        echo "Skipping (already applied): $filename"
    fi
done

echo "Migrations complete"
