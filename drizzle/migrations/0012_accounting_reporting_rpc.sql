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
    coalesce(sum(CASE WHEN m.kind = 'issue' THEN m.qty * m.unit_price ELSE -m.qty * m.unit_price END), 0)::numeric AS value
  FROM public.stock_movements m
  JOIN public.products p ON p.id = m.product_id
  WHERE m.salesman_id = _salesman
  GROUP BY m.product_id, p.name, p.is_smartphone
),
sales_totals AS (
  SELECT coalesce(sum(total), 0)::numeric AS total, coalesce(sum(paid), 0)::numeric AS paid
  FROM public.sales
  WHERE salesman_id = _salesman
),
payment_totals AS (
  SELECT coalesce(sum(amount), 0)::numeric AS amount
  FROM public.retailer_payments
  WHERE salesman_id = _salesman
),
deposit_totals AS (
  SELECT coalesce(sum(amount), 0)::numeric AS amount
  FROM public.deposits
  WHERE salesman_id = _salesman
)
SELECT jsonb_build_object(
  'products', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'product_id', product_id,
      'name', name,
      'isSmart', is_smartphone,
      'issued', issued,
      'sold', sold,
      'returned', returned,
      'damaged', damaged,
      'hand', hand,
      'value', value
    ) ORDER BY name, product_id)
    FROM product_totals
  ), '[]'::jsonb),
  'handImeis', coalesce((
    SELECT jsonb_agg(jsonb_build_object('imei', imei, 'product_id', product_id, 'status', status) ORDER BY imei)
    FROM public.imei_units
    WHERE salesman_id = _salesman AND status = 'with_salesman'
  ), '[]'::jsonb),
  'salesTotal', sales_totals.total,
  'salesPaid', sales_totals.paid,
  'collected', payment_totals.amount,
  'cashInHand', sales_totals.paid + payment_totals.amount - deposit_totals.amount,
  'retailerDue', sales_totals.total - sales_totals.paid - payment_totals.amount,
  'deposited', deposit_totals.amount,
  'owesDealer',
    coalesce((
      SELECT sum(qty * unit_price)
      FROM public.stock_movements
      WHERE salesman_id = _salesman AND kind = 'issue'
    ), 0)
    - coalesce((
      SELECT sum(qty * unit_price)
      FROM public.stock_movements
      WHERE salesman_id = _salesman AND kind IN ('return', 'damage')
    ), 0)
    - deposit_totals.amount
)
FROM sales_totals, payment_totals, deposit_totals;
$$;
REVOKE ALL ON FUNCTION public.salesman_account_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salesman_account_summary(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.retailer_balance_summary()
RETURNS TABLE(retailer_id uuid, sales_total numeric, sale_paid numeric, collected numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH sales AS (
  SELECT retailer_id, sum(total)::numeric AS sales_total, sum(paid)::numeric AS sale_paid
  FROM public.sales
  GROUP BY retailer_id
),
payments AS (
  SELECT retailer_id, sum(amount)::numeric AS collected
  FROM public.retailer_payments
  GROUP BY retailer_id
)
SELECT r.id,
       coalesce(s.sales_total, 0),
       coalesce(s.sale_paid, 0),
       coalesce(p.collected, 0)
FROM public.retailers r
LEFT JOIN sales s ON s.retailer_id = r.id
LEFT JOIN payments p ON p.retailer_id = r.id;
$$;
REVOKE ALL ON FUNCTION public.retailer_balance_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retailer_balance_summary() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.retailer_ledger_page(
  _retailer uuid,
  _from date DEFAULT NULL,
  _to date DEFAULT NULL,
  _limit integer DEFAULT 25,
  _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  start_at timestamptz;
  end_at timestamptz;
BEGIN
  IF _limit < 1 OR _limit > 100 OR _offset < 0 THEN
    RAISE EXCEPTION 'Invalid ledger page';
  END IF;
  IF _from IS NOT NULL AND _to IS NOT NULL AND _from > _to THEN
    RAISE EXCEPTION 'Start date must not be after end date';
  END IF;

  start_at := CASE WHEN _from IS NULL THEN NULL ELSE _from::timestamp AT TIME ZONE 'Asia/Dhaka' END;
  end_at := CASE WHEN _to IS NULL THEN NULL ELSE (_to + 1)::timestamp AT TIME ZONE 'Asia/Dhaka' END;

  WITH entries AS (
    SELECT s.id, 'sale'::text AS entry_type, s.created_at,
           s.total, s.paid, NULL::numeric AS amount, NULL::text AS note
    FROM public.sales s
    WHERE s.retailer_id = _retailer
      AND (start_at IS NULL OR s.created_at >= start_at)
      AND (end_at IS NULL OR s.created_at < end_at)
    UNION ALL
    SELECT p.id, 'payment'::text, p.created_at,
           NULL::numeric, NULL::numeric, p.amount, p.note
    FROM public.retailer_payments p
    WHERE p.retailer_id = _retailer
      AND (start_at IS NULL OR p.created_at >= start_at)
      AND (end_at IS NULL OR p.created_at < end_at)
  ),
  page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC
    LIMIT _limit OFFSET _offset
  ),
  totals AS (
    SELECT count(*)::bigint AS total_count,
           coalesce(sum(total), 0)::numeric AS sales_total,
           coalesce(sum(paid), 0)::numeric AS sale_paid,
           coalesce(sum(amount), 0)::numeric AS collected
    FROM entries
  )
  SELECT jsonb_build_object(
    'totalCount', totals.total_count,
    'salesTotal', totals.sales_total,
    'salePaid', totals.sale_paid,
    'collected', totals.collected,
    'entries', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'entry_type', entry_type, 'created_at', created_at,
        'total', total, 'paid', paid, 'amount', amount, 'note', note
      ) ORDER BY created_at DESC, id DESC)
      FROM page
    ), '[]'::jsonb)
  ) INTO result
  FROM totals;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.retailer_ledger_page(uuid, date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retailer_ledger_page(uuid, date, date, integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.salesman_deposit_page(
  _salesman uuid,
  _from date DEFAULT NULL,
  _to date DEFAULT NULL,
  _limit integer DEFAULT 25,
  _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  start_at timestamptz;
  end_at timestamptz;
BEGIN
  IF _limit < 1 OR _limit > 100 OR _offset < 0 THEN
    RAISE EXCEPTION 'Invalid deposit page';
  END IF;
  IF _from IS NOT NULL AND _to IS NOT NULL AND _from > _to THEN
    RAISE EXCEPTION 'Start date must not be after end date';
  END IF;

  start_at := CASE WHEN _from IS NULL THEN NULL ELSE _from::timestamp AT TIME ZONE 'Asia/Dhaka' END;
  end_at := CASE WHEN _to IS NULL THEN NULL ELSE (_to + 1)::timestamp AT TIME ZONE 'Asia/Dhaka' END;

  WITH entries AS (
    SELECT d.id, d.created_at, d.amount, d.note
    FROM public.deposits d
    WHERE d.salesman_id = _salesman
      AND (start_at IS NULL OR d.created_at >= start_at)
      AND (end_at IS NULL OR d.created_at < end_at)
  ),
  page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC
    LIMIT _limit OFFSET _offset
  )
  SELECT jsonb_build_object(
    'totalCount', (SELECT count(*) FROM entries),
    'entries', coalesce((
      SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC, id DESC)
      FROM page
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.salesman_deposit_page(uuid, date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salesman_deposit_page(uuid, date, date, integer, integer) TO authenticated, service_role;
