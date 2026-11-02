DROP FUNCTION public.retailer_balance_summary();

CREATE FUNCTION public.retailer_balance_summary()
RETURNS jsonb
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
SELECT coalesce(jsonb_object_agg(
  r.id::text,
  jsonb_build_object(
    'sales_total', coalesce(s.sales_total, 0),
    'sale_paid', coalesce(s.sale_paid, 0),
    'collected', coalesce(p.collected, 0)
  )
), '{}'::jsonb)
FROM public.retailers r
LEFT JOIN sales s ON s.retailer_id = r.id
LEFT JOIN payments p ON p.retailer_id = r.id;
$$;

REVOKE ALL ON FUNCTION public.retailer_balance_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retailer_balance_summary() TO authenticated, service_role;
