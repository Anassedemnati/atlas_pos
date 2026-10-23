-- Atlas POS schema v1.
--
-- Conventions: ids are UUIDv7 TEXT; money is integer centimes; quantities are integer
-- thousandths; VAT rates are basis points; timestamps are ISO-8601 strings; *_json columns hold
-- JSON text; booleans are 0/1. A column without NOT NULL is nullable, and NULL means "absent".
-- A foreign key links a row to the parent that owns it. Ids that merely refer to something that
-- may later change or disappear (an order line's product, any user_id, a ticket's order and
-- day) stay plain, so that history never depends on live rows. No ON DELETE actions anywhere:
-- deleting a parent that still has children fails instead of silently deleting data.

-- Settings, audit trail, counters ---------------------------------------------------------------

CREATE TABLE settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE event_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  type      TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT,
  user_id   TEXT,
  data_json TEXT
);
CREATE INDEX idx_event_log_entity ON event_log (entity, entity_id);

CREATE TABLE sequences (
  name  TEXT PRIMARY KEY NOT NULL,
  value INTEGER NOT NULL
);

-- People ---------------------------------------------------------------------------------------

CREATE TABLE profiles (
  id               TEXT PRIMARY KEY NOT NULL,
  name_json        TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  max_discount_bp  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY NOT NULL,
  display_name  TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  username      TEXT UNIQUE,
  password_hash TEXT,
  profile_id    TEXT NOT NULL REFERENCES profiles (id),
  lang          TEXT NOT NULL DEFAULT 'fr',
  active        INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL
);

-- Catalogue ------------------------------------------------------------------------------------

CREATE TABLE categories (
  id         TEXT PRIMARY KEY NOT NULL,
  name_json  TEXT NOT NULL,
  color      TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  image_path TEXT
);

CREATE TABLE products (
  id              TEXT PRIMARY KEY NOT NULL,
  category_id     TEXT NOT NULL REFERENCES categories (id),
  name_json       TEXT NOT NULL,
  price_cents     INTEGER NOT NULL,
  vat_bp          INTEGER NOT NULL,
  barcode         TEXT UNIQUE,
  sold_by_weight  INTEGER NOT NULL DEFAULT 0,
  color           TEXT,
  image_path      TEXT,
  key_size        INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  stock_tracked   INTEGER NOT NULL DEFAULT 0,
  stock_milli     INTEGER NOT NULL DEFAULT 0,
  low_stock_milli INTEGER NOT NULL DEFAULT 0,
  course          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_products_category_id ON products (category_id);

CREATE TABLE modifier_groups (
  id         TEXT PRIMARY KEY NOT NULL,
  name_json  TEXT NOT NULL,
  min_select INTEGER NOT NULL DEFAULT 0,
  max_select INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE modifiers (
  id                TEXT PRIMARY KEY NOT NULL,
  group_id          TEXT NOT NULL REFERENCES modifier_groups (id),
  name_json         TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  sort              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_modifiers_group_id ON modifiers (group_id);

CREATE TABLE product_modifier_groups (
  product_id TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  PRIMARY KEY (product_id, group_id)
);

CREATE TABLE menus (
  id         TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL UNIQUE REFERENCES products (id)
);

CREATE TABLE menu_courses (
  id           TEXT PRIMARY KEY NOT NULL,
  menu_id      TEXT NOT NULL REFERENCES menus (id),
  name_json    TEXT NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0,
  choose_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_menu_courses_menu_id ON menu_courses (menu_id);

CREATE TABLE menu_course_items (
  course_id        TEXT NOT NULL REFERENCES menu_courses (id),
  product_id       TEXT NOT NULL REFERENCES products (id),
  supplement_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, product_id)
);

-- Floor plan -----------------------------------------------------------------------------------

CREATE TABLE rooms (
  id        TEXT PRIMARY KEY NOT NULL,
  name_json TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tables (
  id      TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms (id),
  label   TEXT NOT NULL,
  shape   TEXT NOT NULL DEFAULT 'square' CHECK (shape IN ('square', 'round', 'rect')),
  x       INTEGER NOT NULL DEFAULT 0,
  y       INTEGER NOT NULL DEFAULT 0,
  w       INTEGER NOT NULL DEFAULT 1,
  h       INTEGER NOT NULL DEFAULT 1,
  seats   INTEGER NOT NULL DEFAULT 2,
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_tables_room_id ON tables (room_id);

-- Hardware and payment methods ----------------------------------------------------------------

CREATE TABLE printers (
  id       TEXT PRIMARY KEY NOT NULL,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL,
  address  TEXT NOT NULL DEFAULT '',
  width_mm INTEGER NOT NULL DEFAULT 80,
  lang     TEXT NOT NULL DEFAULT 'fr',
  raster   INTEGER NOT NULL DEFAULT 0,
  role     TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE category_printers (
  category_id TEXT NOT NULL,
  printer_id  TEXT NOT NULL,
  PRIMARY KEY (category_id, printer_id)
);

CREATE TABLE payment_methods (
  id           TEXT PRIMARY KEY NOT NULL,
  code         TEXT NOT NULL UNIQUE,
  name_json    TEXT NOT NULL,
  opens_drawer INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- Customers ------------------------------------------------------------------------------------

CREATE TABLE customers (
  id           TEXT PRIMARY KEY NOT NULL,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  ice          TEXT NOT NULL DEFAULT '',
  is_company   INTEGER NOT NULL DEFAULT 0,
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- Trading days, orders, payments ----------------------------------------------------------------

CREATE TABLE business_days (
  id        TEXT PRIMARY KEY NOT NULL,
  number    INTEGER NOT NULL UNIQUE,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY NOT NULL,
  day_id          TEXT NOT NULL REFERENCES business_days (id),
  type            TEXT NOT NULL CHECK (type IN ('dine_in', 'takeaway', 'delivery', 'counter')),
  table_id        TEXT,
  covers          INTEGER NOT NULL DEFAULT 0,
  order_number    INTEGER,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'parked', 'closed', 'cancelled')),
  user_id         TEXT NOT NULL,
  customer_id     TEXT,
  opened_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  discount_kind   TEXT CHECK (discount_kind IS NULL OR discount_kind IN ('pct', 'amount')),
  discount_value  INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_day_id ON orders (day_id);

CREATE TABLE order_lines (
  id               TEXT PRIMARY KEY NOT NULL,
  order_id         TEXT NOT NULL REFERENCES orders (id),
  seq              INTEGER NOT NULL,
  product_id       TEXT NOT NULL,
  name_json        TEXT NOT NULL,
  qty_milli        INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  vat_bp           INTEGER NOT NULL,
  modifiers_json   TEXT NOT NULL DEFAULT '[]',
  note             TEXT NOT NULL DEFAULT '',
  course           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason      TEXT NOT NULL DEFAULT '',
  sent_at          TEXT,
  discount_kind    TEXT CHECK (discount_kind IS NULL OR discount_kind IN ('pct', 'amount')),
  discount_value   INTEGER NOT NULL DEFAULT 0,
  discount_reason  TEXT NOT NULL DEFAULT '',
  free             INTEGER NOT NULL DEFAULT 0,
  free_reason      TEXT NOT NULL DEFAULT '',
  user_id          TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_order_lines_order_id ON order_lines (order_id);

CREATE TABLE payments (
  id             TEXT PRIMARY KEY NOT NULL,
  order_id       TEXT NOT NULL REFERENCES orders (id),
  method_code    TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  tendered_cents INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  user_id        TEXT NOT NULL
);
CREATE INDEX idx_payments_order_id ON payments (order_id);

-- Legal documents (immutable, see the triggers below) ------------------------------------------

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('sale', 'credit')),
  number        INTEGER NOT NULL,
  label         TEXT NOT NULL UNIQUE,
  order_id      TEXT NOT NULL,
  day_id        TEXT NOT NULL,
  ref_ticket_id TEXT,
  closed_at     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  total_cents   INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reprint_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, number)
);
CREATE INDEX idx_tickets_day_id ON tickets (day_id);

CREATE TABLE invoices (
  id            TEXT PRIMARY KEY NOT NULL,
  number_label  TEXT NOT NULL UNIQUE,
  ticket_id     TEXT NOT NULL UNIQUE REFERENCES tickets (id),
  customer_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE z_reports (
  id         TEXT PRIMARY KEY NOT NULL,
  day_id     TEXT NOT NULL UNIQUE REFERENCES business_days (id),
  number     INTEGER NOT NULL UNIQUE,
  data_json  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id    TEXT NOT NULL
);

-- Print queue and backups -----------------------------------------------------------------------

CREATE TABLE print_jobs (
  id           TEXT PRIMARY KEY NOT NULL,
  printer_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'printing', 'done', 'failed', 'uncertain')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_print_jobs_status ON print_jobs (status);

CREATE TABLE backup_destinations (
  id         TEXT PRIMARY KEY NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('disk', 'usb', 'nas')),
  path       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  target_key TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  last_ok_at TEXT,
  last_error TEXT
);

CREATE TABLE backup_runs (
  id           TEXT PRIMARY KEY NOT NULL,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('live', 'full', 'pre-change', 'manual')),
  file_name    TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  results_json TEXT NOT NULL DEFAULT '[]'
);

-- Immutability ----------------------------------------------------------------------------------
-- A closed ticket never changes (only its reprint counter moves); a correction is a new credit
-- ticket. Invoices and Z reports never change at all. Nothing here can be deleted.

CREATE TRIGGER tickets_no_update
BEFORE UPDATE ON tickets
WHEN NEW.id IS NOT OLD.id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.number IS NOT OLD.number
  OR NEW.label IS NOT OLD.label
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.day_id IS NOT OLD.day_id
  OR NEW.ref_ticket_id IS NOT OLD.ref_ticket_id
  OR NEW.closed_at IS NOT OLD.closed_at
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.total_cents IS NOT OLD.total_cents
  OR NEW.snapshot_json IS NOT OLD.snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'ticket_immutable');
END;

CREATE TRIGGER tickets_no_delete
BEFORE DELETE ON tickets
BEGIN
  SELECT RAISE(ABORT, 'ticket_immutable');
END;

CREATE TRIGGER invoices_no_update
BEFORE UPDATE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;

CREATE TRIGGER invoices_no_delete
BEFORE DELETE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;

CREATE TRIGGER z_reports_no_update
BEFORE UPDATE ON z_reports
BEGIN
  SELECT RAISE(ABORT, 'z_report_immutable');
END;

CREATE TRIGGER z_reports_no_delete
BEFORE DELETE ON z_reports
BEGIN
  SELECT RAISE(ABORT, 'z_report_immutable');
END;
