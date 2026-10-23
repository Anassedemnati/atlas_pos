-- Orders: the pre-bill (addition) was printed for this order; the floor plan shows the table in amber.
-- Set by the till when it prints the pre-bill, never cleared (the order ends in a ticket or a cancellation).
ALTER TABLE orders ADD COLUMN bill_requested_at TEXT;
