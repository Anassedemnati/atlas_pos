-- Orders (Task 12 review): what a manager approved on the order, beyond what the acting user may give on
-- their own. Both are checked by every change that touches the order's discount or what it is measured
-- on (see `checkDiscountLimit` in the order use cases): the order's discount in centimes must stay within
--   max(round(user.maxDiscountBp * gross / 10000), round(approved_ticket_bp * gross / 10000) + approved_cents)
-- plus one centime per discounted line (rounding).
--
-- approved_ticket_bp: a percentage approval, only for a ticket discount of kind 'pct'; it follows the
--   bill (a manager's 50 % stays 50 % of a larger bill). 0 without one.
-- approved_cents: an absolute budget, in centimes, for amount discounts (a 'amount' ticket discount) and
--   all line discounts. It never grows with the bill. 0 without one.
-- They belong to their order: a split hands each part at most its own discount out of the budget, a move
-- carries over at most the moved lines' line discounts, a merge adds the two budgets.

ALTER TABLE orders ADD COLUMN approved_ticket_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN approved_cents INTEGER NOT NULL DEFAULT 0;
