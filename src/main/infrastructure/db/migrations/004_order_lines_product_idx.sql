-- Catalogue (Task 9 review): `order_lines.product_id` is a plain id, not a foreign key, so it had no
-- index. "Was this product ever sold?" (deleting a product, replace import) and every report by
-- product scanned the whole table of sold lines.

CREATE INDEX idx_order_lines_product_id ON order_lines (product_id);
