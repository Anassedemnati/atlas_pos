-- Orders (Task 12 review): the combined discount of the order, in basis points of its discountable
-- gross, as it stood after the last change that passed the discount check (a manager override sets
-- it to what the manager approved). Every change that raises the order's discount or shrinks what it
-- is measured on is checked against max(the acting user's limit, this value), so removing lines after
-- a fixed-amount discount cannot turn an approved 10 % into 25 %. It belongs to its order: it never
-- moves to another one (split, move, merge). NULL: no discount.

ALTER TABLE orders ADD COLUMN discount_approved_bp INTEGER;
