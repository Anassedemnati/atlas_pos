-- Orders (Task 12 review): the largest combined discount, in basis points of the order's discountable
-- gross, that a manager approved for the order (an override, or a session allowed any discount).
-- Every change that raises the order's discount or shrinks what it is measured on is checked against
-- max(the acting user's limit, this approval), so removing lines after a fixed-amount discount cannot
-- turn an approved 10 % into 25 %. NULL: nothing approved beyond the users' own limits.

ALTER TABLE orders ADD COLUMN discount_approved_bp INTEGER;
