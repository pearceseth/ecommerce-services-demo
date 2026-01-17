import { PgClient } from "@effect/sql-pg"
import { Config, Redacted } from "effect"

export const DatabaseLive = PgClient.layerConfig({
  host: Config.string("DATABASE_HOST").pipe(Config.withDefault("localhost")),
  port: Config.number("DATABASE_PORT").pipe(Config.withDefault(5432)),
  database: Config.string("DATABASE_NAME").pipe(Config.withDefault("ecommerce")),
  username: Config.string("DATABASE_USER").pipe(Config.withDefault("ecommerce")),
  password: Config.redacted("DATABASE_PASSWORD").pipe(
    Config.withDefault(Redacted.make("ecommerce"))
  )
})
