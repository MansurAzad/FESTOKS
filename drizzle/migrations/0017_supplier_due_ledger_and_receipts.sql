CREATE TABLE public.supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier text NOT NULL CHECK (length(btrim(supplier)) > 0),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  note text,
  received_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX supplier_payments_supplier_date_idx
  ON public.supplier_payments (lower(btrim(supplier)), created_at DESC, id DESC);

ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.supplier_payments TO authenticated;
GRANT ALL ON public.supplier_payments TO service_role;
CREATE POLICY supplier_payments_owner_read ON public.supplier_payments
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE INSERT, UPDATE, DELETE ON public.supplier_payments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lock_supplier_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(btrim(NEW.supplier)), 0));
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_receipts_lock_supplier_ledger
BEFORE INSERT ON public.stock_receipts
FOR EACH ROW EXECUTE FUNCTION public.lock_supplier_ledger();

CREATE OR REPLACE FUNCTION public.perform_supplier_payment_operation(
  _operation_id uuid,
  _payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  supplier_name text := btrim(_payload ->> 'supplier');
  amount numeric := (_payload ->> 'amount')::numeric;
  existing_actor uuid;
  existing_kind text;
  existing_hash text;
  existing_result jsonb;
  operation_result jsonb;
  inserted_rows integer;
  record_id uuid;
  supplier_due numeric;
BEGIN
  IF actor_id IS NULL OR NOT public.user_is_active(actor_id)
     OR NOT public.has_role(actor_id, 'admin') THEN
    RAISE EXCEPTION 'Active owner account required';
  END IF;
  IF _operation_id IS NULL OR jsonb_typeof(_payload) IS DISTINCT FROM 'object'
     OR coalesce(length(supplier_name), 0) = 0 OR amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'Supplier and positive payment amount are required';
  END IF;

  INSERT INTO public.business_operation_receipts(operation_id, actor, kind, request_hash, result)
  VALUES (_operation_id, actor_id, 'supplier_payment', md5('supplier_payment:' || _payload::text), '{}'::jsonb)
  ON CONFLICT (operation_id) DO NOTHING;
  GET DIAGNOSTICS inserted_rows = ROW_COUNT;
  IF inserted_rows = 0 THEN
    SELECT actor, kind, request_hash, result
      INTO existing_actor, existing_kind, existing_hash, existing_result
      FROM public.business_operation_receipts
      WHERE operation_id = _operation_id FOR UPDATE;
    IF existing_actor IS DISTINCT FROM actor_id OR existing_kind IS DISTINCT FROM 'supplier_payment'
       OR existing_hash IS DISTINCT FROM md5('supplier_payment:' || _payload::text) THEN
      RAISE EXCEPTION 'Operation ID already belongs to a different request';
    END IF;
    RETURN existing_result;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(lower(supplier_name), 0));
  SELECT coalesce(sum(r.quantity_received * r.unit_cost), 0)
       - coalesce((SELECT sum(p.amount) FROM public.supplier_payments p
                   WHERE lower(btrim(p.supplier)) = lower(supplier_name)), 0)
    INTO supplier_due
    FROM public.stock_receipts r
    WHERE lower(btrim(r.supplier)) = lower(supplier_name)
      AND r.unit_cost IS NOT NULL;
  IF amount > supplier_due THEN RAISE EXCEPTION 'Payment exceeds supplier due'; END IF;

  INSERT INTO public.supplier_payments(supplier, amount, note, received_by)
  VALUES (supplier_name, amount, nullif(btrim(_payload ->> 'note'), ''), actor_id)
  RETURNING id INTO record_id;
  operation_result := jsonb_build_object('id', record_id);
  UPDATE public.business_operation_receipts SET result = operation_result
    WHERE operation_id = _operation_id;
  RETURN operation_result;
END;
$$;
REVOKE ALL ON FUNCTION public.perform_supplier_payment_operation(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.perform_supplier_payment_operation(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_retailer_payment_due()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  retailer_salesman uuid;
  due_amount numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_is_active(auth.uid())
     OR NOT public.user_can(auth.uid(), 'collect_payment') THEN
    RAISE EXCEPTION 'Active account with collection permission required';
  END IF;
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN RAISE EXCEPTION 'Positive payment amount required'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.retailer_id IS DISTINCT FROM OLD.retailer_id THEN
    RAISE EXCEPTION 'Payment cannot be moved to another retailer';
  END IF;

  SELECT salesman_id INTO retailer_salesman
    FROM public.retailers WHERE id = NEW.retailer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retailer not found'; END IF;
  IF NOT public.has_role(auth.uid(), 'admin') AND retailer_salesman IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Retailer not yours';
  END IF;

  SELECT coalesce(sum(s.total - s.paid), 0)
       - coalesce((
         SELECT sum(p.amount) FROM public.retailer_payments p
         WHERE p.retailer_id = NEW.retailer_id AND p.id IS DISTINCT FROM NEW.id
       ), 0)
    INTO due_amount
    FROM public.sales s WHERE s.retailer_id = NEW.retailer_id;
  IF NEW.amount > due_amount THEN RAISE EXCEPTION 'Payment exceeds retailer due'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_retailer_payment_due() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER retailer_payment_due_guard
BEFORE INSERT OR UPDATE ON public.retailer_payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_retailer_payment_due();

CREATE OR REPLACE FUNCTION public.manage_supplier_payment(
  _id uuid,
  _action text,
  _amount numeric,
  _note text,
  _reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payment_row public.supplier_payments%ROWTYPE;
  due_without_payment numeric;
  after_data jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_is_active(auth.uid())
     OR NOT public.has_role(auth.uid(), 'admin') OR length(trim(_reason)) < 3
     OR _action NOT IN ('update', 'delete') THEN
    RAISE EXCEPTION 'Active owner, valid action and reason required';
  END IF;
  SELECT * INTO payment_row FROM public.supplier_payments WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier payment not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(btrim(payment_row.supplier)), 0));

  IF _action = 'delete' THEN
    DELETE FROM public.supplier_payments WHERE id = _id;
  ELSE
    IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Positive amount required'; END IF;
    SELECT coalesce(sum(r.quantity_received * r.unit_cost), 0)
         - coalesce((SELECT sum(p.amount) FROM public.supplier_payments p
                     WHERE lower(btrim(p.supplier)) = lower(btrim(payment_row.supplier))
                       AND p.id <> _id), 0)
      INTO due_without_payment
      FROM public.stock_receipts r
      WHERE lower(btrim(r.supplier)) = lower(btrim(payment_row.supplier))
        AND r.unit_cost IS NOT NULL;
    IF _amount > due_without_payment THEN RAISE EXCEPTION 'Payment exceeds supplier due'; END IF;
    UPDATE public.supplier_payments SET amount = _amount, note = nullif(btrim(_note), '')
      WHERE id = _id RETURNING to_jsonb(supplier_payments.*) INTO after_data;
  END IF;

  INSERT INTO public.business_audit(actor, action, entity, entity_id, reason, before_data, after_data)
  VALUES (auth.uid(), _action, 'supplier_payments', _id, _reason, to_jsonb(payment_row), after_data);
END;
$$;
REVOKE ALL ON FUNCTION public.manage_supplier_payment(uuid, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_supplier_payment(uuid, text, numeric, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.supplier_due_summary(_from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  RETURN coalesce((
    WITH supplier_names AS (
      SELECT lower(btrim(supplier)) supplier_key, min(btrim(supplier)) supplier
        FROM public.stock_receipts GROUP BY lower(btrim(supplier))
      UNION
      SELECT lower(btrim(supplier)), min(btrim(supplier))
        FROM public.supplier_payments GROUP BY lower(btrim(supplier))
    ),
    receipt_totals AS (
      SELECT lower(btrim(supplier)) supplier_key,
        sum(quantity_received * unit_cost) FILTER (WHERE unit_cost IS NOT NULL) purchase_total,
        sum(quantity_received * unit_cost) FILTER (
          WHERE unit_cost IS NOT NULL AND (_from IS NULL OR received_on >= _from)
            AND (_to IS NULL OR received_on <= _to)
        ) period_purchases,
        count(*) FILTER (WHERE (_from IS NULL OR received_on >= _from)
          AND (_to IS NULL OR received_on <= _to)) receipt_count
      FROM public.stock_receipts GROUP BY lower(btrim(supplier))
    ),
    payment_totals AS (
      SELECT lower(btrim(supplier)) supplier_key, sum(amount) paid_total,
        sum(amount) FILTER (WHERE (_from IS NULL OR (created_at AT TIME ZONE 'Asia/Dhaka')::date >= _from)
          AND (_to IS NULL OR (created_at AT TIME ZONE 'Asia/Dhaka')::date <= _to)) period_paid,
        count(*) FILTER (WHERE (_from IS NULL OR (created_at AT TIME ZONE 'Asia/Dhaka')::date >= _from)
          AND (_to IS NULL OR (created_at AT TIME ZONE 'Asia/Dhaka')::date <= _to)) payment_count
      FROM public.supplier_payments GROUP BY lower(btrim(supplier))
    )
    SELECT jsonb_agg(jsonb_build_object(
      'supplier', n.supplier,
      'purchase_total', coalesce(r.purchase_total, 0),
      'paid_total', coalesce(p.paid_total, 0),
      'due', coalesce(r.purchase_total, 0) - coalesce(p.paid_total, 0),
      'period_purchases', coalesce(r.period_purchases, 0),
      'period_paid', coalesce(p.period_paid, 0),
      'receipt_count', coalesce(r.receipt_count, 0),
      'payment_count', coalesce(p.payment_count, 0)
    ) ORDER BY n.supplier)
    FROM supplier_names n
    LEFT JOIN receipt_totals r USING (supplier_key)
    LEFT JOIN payment_totals p USING (supplier_key)
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.supplier_due_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_due_summary(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.supplier_ledger_page(
  _supplier text,
  _from date DEFAULT NULL,
  _to date DEFAULT NULL,
  _limit integer DEFAULT 25,
  _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE supplier_key text := lower(btrim(_supplier));
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  IF coalesce(length(supplier_key), 0) = 0 OR _limit < 1 OR _limit > 100 OR _offset < 0 THEN
    RAISE EXCEPTION 'Invalid supplier or page';
  END IF;
  RETURN (
    WITH all_entries AS (
      SELECT r.id, 'receipt'::text entry_type, r.received_on::timestamp at time zone 'Asia/Dhaka' created_at,
        r.supplier, r.purchase_reference reference, r.product_id,
        p.name product_name, r.quantity_received quantity, r.unit_cost,
        r.quantity_received * r.unit_cost amount, NULL::text note
      FROM public.stock_receipts r LEFT JOIN public.products p ON p.id = r.product_id
      WHERE lower(btrim(r.supplier)) = supplier_key AND r.unit_cost IS NOT NULL
      UNION ALL
      SELECT p.id, 'payment', p.created_at, p.supplier, NULL, NULL, NULL,
        NULL, NULL, p.amount, p.note
      FROM public.supplier_payments p
      WHERE lower(btrim(p.supplier)) = supplier_key
    ),
    filtered AS (
      SELECT * FROM all_entries
      WHERE (_from IS NULL OR (created_at AT TIME ZONE 'Asia/Dhaka')::date >= _from)
        AND (_to IS NULL OR (created_at AT TIME ZONE 'Asia/Dhaka')::date <= _to)
    )
    SELECT jsonb_build_object(
      'totalCount', (SELECT count(*) FROM filtered),
      'entries', coalesce((
        SELECT jsonb_agg(to_jsonb(page) ORDER BY page.created_at DESC, page.id DESC)
        FROM (
          SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT _limit OFFSET _offset
        ) page
      ), '[]'::jsonb)
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.supplier_ledger_page(text, date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_ledger_page(text, date, date, integer, integer) TO authenticated;

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
  'supplier_payments', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.supplier_payments t),
  'deposits', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.deposits t),
  'dealer_blocks', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY retailer_id), '[]') FROM public.dealer_blocks t),
  'dealer_risk_assessments', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY retailer_id), '[]') FROM public.dealer_risk_assessments t)
);
$$;

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
    public.sales, public.stock_movements, public.retailer_payments, public.supplier_payments,
    public.deposits, public.dealer_blocks, public.dealer_risk_assessments IN SHARE MODE;
  snap := public.business_snapshot();
  IF octet_length(snap::text) > 20971520 THEN RAISE EXCEPTION 'Use Cloud export for data larger than 20 MB'; END IF;
  INSERT INTO public.business_exports(actor, snapshot) VALUES (auth.uid(), snap) RETURNING id INTO bid;
  RETURN jsonb_build_object('format', 'firoza-business-data', 'version', 3, 'source', bid, 'exported_at', now(), 'tables', snap);
END;
$$;

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
    public.sales, public.stock_movements, public.retailer_payments, public.supplier_payments,
    public.deposits, public.dealer_blocks, public.dealer_risk_assessments IN ACCESS EXCLUSIVE MODE;
  SELECT snapshot INTO snap FROM public.business_exports
  WHERE id = _backup_id AND actor = auth.uid() AND created_at > now() - interval '30 minutes';
  IF snap IS NULL OR snap IS DISTINCT FROM public.business_snapshot() THEN
    RAISE EXCEPTION 'Download a fresh backup first; data may have changed';
  END IF;
  DELETE FROM public.dealer_risk_assessments WHERE retailer_id IS NOT NULL;
  DELETE FROM public.dealer_blocks WHERE retailer_id IS NOT NULL;
  DELETE FROM public.stock_movements;
  DELETE FROM public.supplier_payments;
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
     OR version_text IS NULL OR version_text NOT IN ('1', '2', '3')
     OR octet_length(_snapshot::text) > 20971520 THEN
    RAISE EXCEPTION 'Invalid backup format or size';
  END IF;
  SELECT snapshot INTO saved FROM public.business_exports WHERE id = (_snapshot->>'source')::uuid;
  IF saved IS NULL OR saved IS DISTINCT FROM _snapshot->'tables' THEN
    RAISE EXCEPTION 'Backup is modified or belongs to another installation';
  END IF;
  IF version_text IN ('2', '3') AND NOT (saved ? 'stock_receipts') THEN
    RAISE EXCEPTION 'Version 2+ backup is missing stock receipts';
  END IF;
  IF version_text = '3' AND NOT (saved ? 'supplier_payments') THEN
    RAISE EXCEPTION 'Version 3 backup is missing supplier payments';
  END IF;

  PERFORM public.reset_business_data('RESET FIROZA', _backup_id);
  PERFORM set_config('app.stock_write', 'enabled', true);
  INSERT INTO public.products SELECT * FROM jsonb_populate_recordset(NULL::public.products, saved->'products');
  INSERT INTO public.retailers SELECT * FROM jsonb_populate_recordset(NULL::public.retailers, saved->'retailers');
  IF version_text IN ('2', '3') THEN
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
  IF version_text = '3' THEN
    INSERT INTO public.supplier_payments SELECT * FROM jsonb_populate_recordset(NULL::public.supplier_payments, saved->'supplier_payments');
  END IF;
  INSERT INTO public.deposits SELECT * FROM jsonb_populate_recordset(NULL::public.deposits, saved->'deposits');
  IF version_text = '1' THEN PERFORM public.create_legacy_opening_stock_receipts(); END IF;
  PERFORM set_config('app.stock_write', '', true);
  INSERT INTO public.business_audit(actor, action, reason, after_data)
  VALUES (auth.uid(), 'restore', 'RESTORE FIROZA',
    jsonb_build_object('source', _snapshot->>'source', 'safety_backup', _backup_id, 'version', version_text));
END;
$$;
