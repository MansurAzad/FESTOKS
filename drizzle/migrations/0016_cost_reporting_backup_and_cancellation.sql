CREATE OR REPLACE FUNCTION public.salesman_account_summary(_salesman uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH product_totals AS (
  SELECT
    m.product_id,
    p.name,
    p.is_smartphone,
    coalesce(sum(m.qty) FILTER (WHERE m.kind = 'issue'), 0)::bigint AS issued,
    coalesce(sum(m.qty) FILTER (WHERE m.kind = 'sale'), 0)::bigint AS sold,
    coalesce(sum(m.qty) FILTER (WHERE m.kind = 'return'), 0)::bigint AS returned,
    coalesce(sum(m.qty) FILTER (WHERE m.kind = 'damage'), 0)::bigint AS damaged,
    coalesce(sum(CASE WHEN m.kind = 'issue' THEN m.qty ELSE -m.qty END), 0)::bigint AS hand,
    coalesce(sum(CASE WHEN m.unit_cost IS NULL THEN
      CASE WHEN m.kind = 'issue' THEN m.qty ELSE -m.qty END
      ELSE 0 END), 0)::bigint AS unknown_cost_hand,
    coalesce(sum(CASE WHEN m.unit_cost IS NOT NULL THEN
      CASE WHEN m.kind = 'issue' THEN m.qty * m.unit_cost ELSE -m.qty * m.unit_cost END
      ELSE 0 END), 0)::numeric AS value,
    coalesce(sum(m.qty * (m.unit_price - m.unit_cost)) FILTER (
      WHERE m.kind = 'sale' AND m.unit_cost IS NOT NULL
    ), 0)::numeric AS known_gross_profit
  FROM public.stock_movements m
  JOIN public.products p ON p.id = m.product_id
  WHERE m.salesman_id = _salesman
  GROUP BY m.product_id, p.name, p.is_smartphone
),
sales_totals AS (
  SELECT coalesce(sum(total), 0)::numeric AS total, coalesce(sum(paid), 0)::numeric AS paid
  FROM public.sales WHERE salesman_id = _salesman
),
payment_totals AS (
  SELECT coalesce(sum(amount), 0)::numeric AS amount
  FROM public.retailer_payments WHERE salesman_id = _salesman
),
deposit_totals AS (
  SELECT coalesce(sum(amount), 0)::numeric AS amount
  FROM public.deposits WHERE salesman_id = _salesman
),
stock_costs AS (
  SELECT
    coalesce(sum(CASE WHEN kind = 'issue' THEN qty * unit_cost
      WHEN kind IN ('sale', 'return', 'damage') THEN -qty * unit_cost END)
      FILTER (WHERE unit_cost IS NOT NULL), 0)::numeric AS known_held_cost,
    coalesce(sum(CASE WHEN kind = 'issue' THEN qty * unit_cost
      WHEN kind IN ('return', 'damage') THEN -qty * unit_cost END)
      FILTER (WHERE unit_cost IS NOT NULL), 0)::numeric AS known_owed_cost,
    coalesce(sum(CASE WHEN unit_cost IS NULL THEN
      CASE WHEN kind = 'issue' THEN qty
        WHEN kind IN ('sale', 'return', 'damage') THEN -qty ELSE 0 END
      ELSE 0 END), 0)::bigint AS unknown_held_qty,
    coalesce(sum(CASE WHEN unit_cost IS NULL THEN
      CASE WHEN kind = 'issue' THEN qty
        WHEN kind IN ('return', 'damage') THEN -qty ELSE 0 END
      ELSE 0 END), 0)::bigint AS unknown_owed_qty,
    coalesce(sum(qty) FILTER (WHERE kind = 'sale' AND unit_cost IS NULL), 0)::bigint AS unknown_sold_qty
  FROM public.stock_movements WHERE salesman_id = _salesman
)
SELECT jsonb_build_object(
  'products', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'product_id', product_id, 'name', name, 'isSmart', is_smartphone,
      'issued', issued, 'sold', sold, 'returned', returned, 'damaged', damaged,
      'hand', hand, 'value', value, 'unknownCostHand', unknown_cost_hand,
      'knownGrossProfit', known_gross_profit
    ) ORDER BY name, product_id) FROM product_totals
  ), '[]'::jsonb),
  'handImeis', coalesce((
    SELECT jsonb_agg(jsonb_build_object('imei', imei, 'product_id', product_id, 'status', status) ORDER BY imei)
    FROM public.imei_units WHERE salesman_id = _salesman AND status = 'with_salesman'
  ), '[]'::jsonb),
  'salesTotal', sales_totals.total,
  'salesPaid', sales_totals.paid,
  'collected', payment_totals.amount,
  'cashInHand', sales_totals.paid + payment_totals.amount - deposit_totals.amount,
  'retailerDue', sales_totals.total - sales_totals.paid - payment_totals.amount,
  'deposited', deposit_totals.amount,
  'owesDealer', stock_costs.known_owed_cost - deposit_totals.amount,
  'owesDealerUnknownQty', stock_costs.unknown_owed_qty,
  'unknownCostSoldQty', stock_costs.unknown_sold_qty
)
FROM sales_totals, payment_totals, deposit_totals, stock_costs;
$$;
REVOKE ALL ON FUNCTION public.salesman_account_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salesman_account_summary(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.distribution_insights()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH payment_totals AS (
  SELECT retailer_id, sum(amount) amount FROM public.retailer_payments GROUP BY retailer_id
),
invoice_balances AS (
  SELECT s.id, s.retailer_id, s.created_at, greatest(s.total - s.paid, 0) balance,
    coalesce(p.amount, 0) payments,
    coalesce(sum(greatest(s.total - s.paid, 0)) OVER (
      PARTITION BY s.retailer_id ORDER BY s.created_at, s.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) prior_balance
  FROM public.sales s LEFT JOIN payment_totals p ON p.retailer_id = s.retailer_id
),
outstanding AS (
  SELECT *, greatest(balance - greatest(payments - prior_balance, 0), 0) remaining
  FROM invoice_balances
),
aged AS (
  SELECT retailer_id, sum(remaining) total_due,
    sum(remaining) FILTER (WHERE created_at <= now() - interval '30 days') overdue_amount,
    min(created_at) FILTER (WHERE remaining > 0) oldest
  FROM outstanding GROUP BY retailer_id HAVING sum(remaining) > 0
),
overdue AS (
  SELECT r.id, r.name, r.phone, r.address, r.salesman_id, p.full_name salesman_name,
    a.total_due, a.overdue_amount, extract(day FROM now() - a.oldest)::integer age_days
  FROM aged a JOIN public.retailers r ON r.id = a.retailer_id
  LEFT JOIN public.profiles p ON p.id = r.salesman_id
  WHERE a.overdue_amount > 0 ORDER BY a.oldest, r.name
),
stock AS (
  SELECT p.id, p.name, p.model, p.low_stock_threshold,
    CASE WHEN p.is_smartphone THEN (
      SELECT count(*) FROM public.imei_units i WHERE i.product_id = p.id AND i.status = 'in_stock'
    ) ELSE p.stock_qty END qty
  FROM public.products p
),
warehouse_cost AS (
  SELECT
    coalesce(sum(quantity_remaining * unit_cost) FILTER (WHERE unit_cost IS NOT NULL), 0)::numeric known_value,
    coalesce(sum(quantity_remaining) FILTER (WHERE unit_cost IS NULL), 0)::bigint unknown_qty
  FROM public.stock_receipts
),
moves AS (
  SELECT
    coalesce(sum(CASE WHEN kind = 'issue' THEN qty ELSE -qty END), 0)::bigint held,
    coalesce(sum(CASE WHEN kind = 'issue' THEN qty * unit_cost
      WHEN kind IN ('sale', 'return', 'damage') THEN -qty * unit_cost END)
      FILTER (WHERE unit_cost IS NOT NULL), 0)::numeric held_value,
    coalesce(sum(CASE WHEN unit_cost IS NULL THEN
      CASE WHEN kind = 'issue' THEN qty
        WHEN kind IN ('sale', 'return', 'damage') THEN -qty ELSE 0 END
      ELSE 0 END), 0)::bigint held_unknown_qty,
    coalesce(sum(qty * (unit_price - unit_cost)) FILTER (
      WHERE kind = 'sale' AND unit_cost IS NOT NULL
    ), 0)::numeric known_gross_profit,
    coalesce(sum(qty) FILTER (WHERE kind = 'sale' AND unit_cost IS NULL), 0)::bigint unknown_sold_qty,
    coalesce(sum(qty) FILTER (WHERE kind = 'return'), 0)::bigint returned,
    coalesce(sum(qty) FILTER (WHERE kind = 'damage'), 0)::bigint damaged
  FROM public.stock_movements
),
sales_kpis AS (
  SELECT coalesce(sum(total), 0) total, coalesce(sum(paid), 0) paid,
    coalesce(sum(total) FILTER (
      WHERE (created_at AT TIME ZONE 'Asia/Dhaka')::date = (now() AT TIME ZONE 'Asia/Dhaka')::date
    ), 0) today_sales,
    coalesce(sum(total) FILTER (
      WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Dhaka') =
        date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka')
    ), 0) month_sales,
    count(*) invoices FROM public.sales
),
totals AS (
  SELECT coalesce((SELECT sum(amount) FROM public.retailer_payments), 0) collected,
    coalesce((SELECT sum(amount) FROM public.deposits), 0) deposited
)
SELECT jsonb_build_object(
  'overdue', coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.age_days DESC, o.name) FROM overdue o), '[]'::jsonb),
  'overdueTotal', coalesce((SELECT sum(overdue_amount) FROM overdue), 0),
  'lowStock', CASE WHEN public.has_role(auth.uid(), 'admin')
    THEN coalesce((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.qty, st.name) FROM stock st WHERE st.qty < st.low_stock_threshold), '[]'::jsonb)
    ELSE '[]'::jsonb END,
  'warehouseQty', CASE WHEN public.has_role(auth.uid(), 'admin') THEN (SELECT coalesce(sum(qty), 0) FROM stock) ELSE NULL END,
  'warehouseValue', CASE WHEN public.has_role(auth.uid(), 'admin') THEN warehouse_cost.known_value ELSE NULL END,
  'warehouseUnknownCostQty', CASE WHEN public.has_role(auth.uid(), 'admin') THEN warehouse_cost.unknown_qty ELSE NULL END,
  'todaySales', s.today_sales, 'monthSales', s.month_sales, 'salesTotal', s.total, 'invoiceCount', s.invoices,
  'collected', s.paid + t.collected, 'cashInHand', s.paid + t.collected - t.deposited,
  'deposited', t.deposited, 'retailerDue', s.total - s.paid - t.collected,
  'heldQty', m.held, 'heldValue', m.held_value, 'heldUnknownCostQty', m.held_unknown_qty,
  'knownGrossProfit', m.known_gross_profit, 'unknownCostSoldQty', m.unknown_sold_qty,
  'returnedQty', m.returned, 'damagedQty', m.damaged,
  'retailerCount', (SELECT count(*) FROM public.retailers),
  'activeSalesmen', (SELECT count(*) FROM public.profiles pr JOIN public.user_roles ur ON ur.user_id = pr.id
    WHERE ur.role = 'salesman' AND pr.active)
)
FROM moves m CROSS JOIN sales_kpis s CROSS JOIN totals t CROSS JOIN warehouse_cost;
$$;
REVOKE ALL ON FUNCTION public.distribution_insights() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distribution_insights() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.business_snapshot()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
SELECT jsonb_build_object(
  'products', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.products t),
  'retailers', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.retailers t),
  'stock_receipts', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.stock_receipts t),
  'imei_units', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.imei_units t),
  'sales', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.sales t),
  'stock_movements', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.stock_movements t),
  'retailer_payments', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.retailer_payments t),
  'deposits', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.deposits t),
  'dealer_blocks', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY retailer_id), '[]') FROM public.dealer_blocks t),
  'dealer_risk_assessments', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY retailer_id), '[]') FROM public.dealer_risk_assessments t)
);
$$;
REVOKE ALL ON FUNCTION public.business_snapshot() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.export_business_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE snap jsonb; bid uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  LOCK TABLE public.products, public.retailers, public.stock_receipts, public.imei_units,
    public.sales, public.stock_movements, public.retailer_payments, public.deposits,
    public.dealer_blocks, public.dealer_risk_assessments IN SHARE MODE;
  snap := public.business_snapshot();
  IF octet_length(snap::text) > 20971520 THEN RAISE EXCEPTION 'Use Cloud export for data larger than 20 MB'; END IF;
  INSERT INTO public.business_exports(actor, snapshot) VALUES (auth.uid(), snap) RETURNING id INTO bid;
  RETURN jsonb_build_object('format', 'firoza-business-data', 'version', 2, 'source', bid, 'exported_at', now(), 'tables', snap);
END;
$$;
REVOKE ALL ON FUNCTION public.export_business_data() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.export_business_data() TO authenticated;

CREATE OR REPLACE FUNCTION public.reset_business_data(_confirmation text, _backup_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE snap jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') OR _confirmation IS DISTINCT FROM 'RESET FIROZA' THEN
    RAISE EXCEPTION 'Owner confirmation required';
  END IF;
  LOCK TABLE public.products, public.retailers, public.stock_receipts, public.imei_units,
    public.sales, public.stock_movements, public.retailer_payments, public.deposits,
    public.dealer_blocks, public.dealer_risk_assessments IN ACCESS EXCLUSIVE MODE;
  SELECT snapshot INTO snap FROM public.business_exports
  WHERE id = _backup_id AND actor = auth.uid() AND created_at > now() - interval '30 minutes';
  IF snap IS NULL OR snap IS DISTINCT FROM public.business_snapshot() THEN
    RAISE EXCEPTION 'Download a fresh backup first; data may have changed';
  END IF;
  DELETE FROM public.dealer_risk_assessments WHERE retailer_id IS NOT NULL;
  DELETE FROM public.dealer_blocks WHERE retailer_id IS NOT NULL;
  DELETE FROM public.stock_movements;
  DELETE FROM public.retailer_payments;
  DELETE FROM public.deposits;
  DELETE FROM public.sales;
  DELETE FROM public.imei_units;
  DELETE FROM public.stock_receipts;
  DELETE FROM public.retailers;
  DELETE FROM public.products;
  INSERT INTO public.business_audit(actor, action, reason, before_data)
  VALUES (auth.uid(), 'reset', 'RESET FIROZA', jsonb_build_object('backup_id', _backup_id));
END;
$$;
REVOKE ALL ON FUNCTION public.reset_business_data(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_business_data(text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_business_data(_confirmation text, _snapshot jsonb, _backup_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE saved jsonb; version_text text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') OR _confirmation IS DISTINCT FROM 'RESTORE FIROZA' THEN
    RAISE EXCEPTION 'Owner confirmation required';
  END IF;
  version_text := _snapshot->>'version';
  IF _snapshot->>'format' IS DISTINCT FROM 'firoza-business-data'
     OR version_text IS NULL OR version_text NOT IN ('1', '2')
     OR octet_length(_snapshot::text) > 20971520 THEN
    RAISE EXCEPTION 'Invalid backup format or size';
  END IF;
  SELECT snapshot INTO saved FROM public.business_exports WHERE id = (_snapshot->>'source')::uuid;
  IF saved IS NULL OR saved IS DISTINCT FROM _snapshot->'tables' THEN
    RAISE EXCEPTION 'Backup is modified or belongs to another installation';
  END IF;
  IF version_text = '2' AND NOT (saved ? 'stock_receipts') THEN
    RAISE EXCEPTION 'Version 2 backup is missing stock receipts';
  END IF;

  PERFORM public.reset_business_data('RESET FIROZA', _backup_id);
  PERFORM set_config('app.stock_write', 'enabled', true);
  INSERT INTO public.products SELECT * FROM jsonb_populate_recordset(NULL::public.products, saved->'products');
  INSERT INTO public.retailers SELECT * FROM jsonb_populate_recordset(NULL::public.retailers, saved->'retailers');
  IF version_text = '2' THEN
    INSERT INTO public.stock_receipts SELECT * FROM jsonb_populate_recordset(NULL::public.stock_receipts, saved->'stock_receipts');
    PERFORM setval(
      pg_get_serial_sequence('public.stock_receipts', 'receipt_order'),
      coalesce((SELECT max(receipt_order) FROM public.stock_receipts), 1),
      EXISTS (SELECT 1 FROM public.stock_receipts)
    );
  END IF;
  INSERT INTO public.imei_units SELECT * FROM jsonb_populate_recordset(NULL::public.imei_units, saved->'imei_units');
  INSERT INTO public.sales SELECT * FROM jsonb_populate_recordset(NULL::public.sales, saved->'sales');
  INSERT INTO public.stock_movements SELECT * FROM jsonb_populate_recordset(NULL::public.stock_movements, saved->'stock_movements');
  INSERT INTO public.retailer_payments SELECT * FROM jsonb_populate_recordset(NULL::public.retailer_payments, saved->'retailer_payments');
  INSERT INTO public.deposits SELECT * FROM jsonb_populate_recordset(NULL::public.deposits, saved->'deposits');
  IF version_text = '1' THEN
    PERFORM public.create_legacy_opening_stock_receipts();
  END IF;
  PERFORM set_config('app.stock_write', '', true);
  INSERT INTO public.business_audit(actor, action, reason, after_data)
  VALUES (auth.uid(), 'restore', 'RESTORE FIROZA',
    jsonb_build_object('source', _snapshot->>'source', 'safety_backup', _backup_id, 'version', version_text));
END;
$$;
REVOKE ALL ON FUNCTION public.restore_business_data(text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_business_data(text, jsonb, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_business_history(_table text, _id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sale_row public.sales%ROWTYPE;
  movement public.stock_movements%ROWTYPE;
  product public.products%ROWTYPE;
  old_data jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') OR length(trim(_reason)) < 3 THEN
    RAISE EXCEPTION 'Owner and reason required';
  END IF;
  LOCK TABLE public.products, public.retailers, public.stock_receipts, public.imei_units,
    public.sales, public.stock_movements, public.retailer_payments, public.deposits,
    public.dealer_blocks, public.dealer_risk_assessments IN SHARE ROW EXCLUSIVE MODE;

  IF _table = 'sales' THEN
    SELECT * INTO sale_row FROM public.sales WHERE id = _id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF EXISTS (SELECT 1 FROM public.retailer_payments WHERE retailer_id = sale_row.retailer_id) THEN
      RAISE EXCEPTION 'Retailer has payments; reconcile them before cancelling invoice';
    END IF;
    FOR movement IN SELECT * FROM public.stock_movements WHERE sale_id = _id LOOP
      IF movement.imei IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM public.stock_movements later
          WHERE later.imei = movement.imei AND later.sale_id IS DISTINCT FROM _id
            AND (later.created_at, later.id) > (movement.created_at, movement.id)
        ) THEN RAISE EXCEPTION 'Later IMEI history prevents cancellation'; END IF;
        UPDATE public.imei_units SET status = 'with_salesman', retailer_id = NULL
        WHERE imei = movement.imei AND status = 'sold' AND salesman_id = movement.salesman_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
      ELSIF movement.receipt_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.stock_movements later
        WHERE later.receipt_id = movement.receipt_id AND later.sale_id IS DISTINCT FROM _id
          AND (later.created_at, later.id) > (movement.created_at, movement.id)
      ) THEN
        RAISE EXCEPTION 'Later receipt history prevents cancellation';
      END IF;
    END LOOP;
    old_data := jsonb_build_object(
      'sale', to_jsonb(sale_row),
      'items', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]') FROM public.stock_movements t WHERE sale_id = _id)
    );
    DELETE FROM public.stock_movements WHERE sale_id = _id;
    DELETE FROM public.sales WHERE id = _id;
  ELSIF _table = 'stock_movements' THEN
    SELECT * INTO movement FROM public.stock_movements WHERE id = _id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Movement not found'; END IF;
    IF movement.kind = 'sale' THEN RAISE EXCEPTION 'Cancel the whole invoice instead'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.stock_movements later
      WHERE later.salesman_id = movement.salesman_id AND later.product_id = movement.product_id
        AND (later.created_at, later.id) > (movement.created_at, movement.id)
    ) THEN RAISE EXCEPTION 'Later stock history prevents cancellation'; END IF;
    IF movement.receipt_id IS NULL THEN RAISE EXCEPTION 'Movement has no purchase receipt'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.stock_movements later
      WHERE later.receipt_id = movement.receipt_id
        AND (later.created_at, later.id) > (movement.created_at, movement.id)
    ) THEN RAISE EXCEPTION 'Later receipt history prevents cancellation'; END IF;
    SELECT * INTO product FROM public.products WHERE id = movement.product_id FOR UPDATE;
    old_data := to_jsonb(movement);

    IF movement.imei IS NOT NULL THEN
      IF movement.kind = 'issue' THEN
        UPDATE public.imei_units SET status = 'in_stock', salesman_id = NULL, retailer_id = NULL
        WHERE imei = movement.imei AND status = 'with_salesman' AND salesman_id = movement.salesman_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
        UPDATE public.stock_receipts SET quantity_remaining = quantity_remaining + 1
        WHERE id = movement.receipt_id AND quantity_remaining < quantity_received;
      ELSIF movement.kind = 'return' THEN
        UPDATE public.imei_units SET status = 'with_salesman', salesman_id = movement.salesman_id, retailer_id = NULL
        WHERE imei = movement.imei AND status = 'in_stock' AND salesman_id IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
        UPDATE public.stock_receipts SET quantity_remaining = quantity_remaining - 1
        WHERE id = movement.receipt_id AND quantity_remaining > 0;
      ELSIF movement.kind = 'damage' THEN
        UPDATE public.imei_units SET status = 'with_salesman', salesman_id = movement.salesman_id, retailer_id = NULL
        WHERE imei = movement.imei AND status = 'damaged' AND salesman_id IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
      END IF;
    ELSIF movement.kind = 'issue' THEN
      IF public.holding_qty(movement.salesman_id, movement.product_id) < movement.qty THEN
        RAISE EXCEPTION 'Issued stock is no longer in hand';
      END IF;
      UPDATE public.stock_receipts SET quantity_remaining = quantity_remaining + movement.qty
      WHERE id = movement.receipt_id AND quantity_remaining + movement.qty <= quantity_received;
      IF NOT FOUND THEN RAISE EXCEPTION 'Receipt balance is inconsistent'; END IF;
      PERFORM set_config('app.stock_write', 'enabled', true);
      UPDATE public.products SET stock_qty = stock_qty + movement.qty WHERE id = movement.product_id;
    ELSIF movement.kind = 'return' THEN
      IF product.stock_qty < movement.qty THEN RAISE EXCEPTION 'Returned stock is no longer available'; END IF;
      UPDATE public.stock_receipts SET quantity_remaining = quantity_remaining - movement.qty
      WHERE id = movement.receipt_id AND quantity_remaining >= movement.qty;
      IF NOT FOUND THEN RAISE EXCEPTION 'Receipt balance is inconsistent'; END IF;
      PERFORM set_config('app.stock_write', 'enabled', true);
      UPDATE public.products SET stock_qty = stock_qty - movement.qty WHERE id = movement.product_id;
    ELSIF movement.kind <> 'damage' THEN
      RAISE EXCEPTION 'Unsupported stock history';
    END IF;
    IF NOT FOUND AND movement.kind IN ('issue', 'return') THEN RAISE EXCEPTION 'Receipt balance is inconsistent'; END IF;
    DELETE FROM public.stock_movements WHERE id = _id;
  ELSE
    RAISE EXCEPTION 'Unsupported history';
  END IF;

  PERFORM set_config('app.stock_write', '', true);
  INSERT INTO public.business_audit(actor, action, entity, entity_id, reason, before_data)
  VALUES (auth.uid(), 'cancel', _table, _id, _reason, old_data);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_business_history(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_business_history(text, uuid, text) TO authenticated;

CREATE FUNCTION public.perform_stock_receipt_operation(_operation_id uuid, _payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  existing_actor uuid;
  existing_kind text;
  existing_hash text;
  existing_result jsonb;
  receipt_id uuid;
BEGIN
  IF actor_id IS NULL OR NOT public.user_is_active(actor_id) THEN
    RAISE EXCEPTION 'Account inactive or unauthenticated';
  END IF;
  IF _operation_id IS NULL OR _payload IS NULL OR jsonb_typeof(_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Operation ID and object payload are required';
  END IF;
  INSERT INTO public.business_operation_receipts(operation_id, actor, kind, request_hash, result)
  VALUES (_operation_id, actor_id, 'receive_stock', md5('receive_stock:' || _payload::text), '{}'::jsonb)
  ON CONFLICT (operation_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT actor, kind, request_hash, result
    INTO existing_actor, existing_kind, existing_hash, existing_result
    FROM public.business_operation_receipts WHERE operation_id = _operation_id FOR UPDATE;
    IF existing_actor IS DISTINCT FROM actor_id OR existing_kind IS DISTINCT FROM 'receive_stock'
       OR existing_hash IS DISTINCT FROM md5('receive_stock:' || _payload::text) THEN
      RAISE EXCEPTION 'Operation ID already belongs to a different request';
    END IF;
    RETURN existing_result;
  END IF;

  receipt_id := public.receive_stock(
    (_payload->>'_product')::uuid,
    _payload->'_imeis',
    (_payload->>'_quantity')::integer,
    _payload->>'_supplier',
    _payload->>'_purchase_reference',
    _payload->>'_batch_reference',
    (_payload->>'_unit_cost')::numeric,
    (_payload->>'_received_on')::date,
    _payload->>'_note'
  );
  UPDATE public.business_operation_receipts
  SET result = jsonb_build_object('id', receipt_id)
  WHERE operation_id = _operation_id;
  RETURN jsonb_build_object('id', receipt_id);
END;
$$;
REVOKE ALL ON FUNCTION public.perform_stock_receipt_operation(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.perform_stock_receipt_operation(uuid, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.receive_stock(uuid,jsonb,integer,text,text,text,numeric,date,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.receive_button_stock(uuid,integer,text) FROM authenticated;
