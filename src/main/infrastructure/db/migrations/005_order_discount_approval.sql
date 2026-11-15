-- Orders (Task 12b ruling): the discount allowance of an order is ADDITIVE. Every change that touches the
-- order's discount, or what it is measured on, checks (see `checkDiscountLimit` in the order use cases)
-- that the order's discount in centimes stays within
--     round(max(session.maxDiscountBp, own_grant_bp) * gross / 10000)   -- staff authority
--   + one centime per discounted line                                   -- rounding
--   + round(approved_ticket_bp * gross / 10000)                         -- a manager's ticket percentage
--   + approved_cents                                                    -- a manager's budget
-- for the acting session (a session holding order.discount.override is not limited). Each column records
-- only what its grantor actually authorised:
--
-- own_grant_bp: the highest own-limit percentage (bp) a LIMITED session legitimately used on the order
--   (staff acting within their own limit, no token). Never reduced; capped at that session's limit.
-- approved_ticket_bp: a ticket percentage a manager or override approved, beyond the staff authority in
--   force at the time; only for a ticket discount of kind 'pct', it follows the bill. 0 once the ticket
--   discount is removed.
-- approved_cents: an absolute budget, in centimes, a manager or override approved beyond everything the
--   order already allowed, recorded as INCREMENTS (a no-op, a removal or a covered change adds 0). It
--   never grows with the bill. 0 once no line discount and no amount ticket discount is left.
-- They belong to their order: a split hands every piece the two percentages and partitions the budget
-- (each piece takes what its stored grants do not cover, parts first), a move carries over at most the
-- moved lines' line discounts, a merge takes the higher own_grant_bp, the target's ticket percentage and
-- the two budgets added up.

ALTER TABLE orders ADD COLUMN own_grant_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN approved_ticket_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN approved_cents INTEGER NOT NULL DEFAULT 0;
