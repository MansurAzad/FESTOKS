CREATE INDEX IF NOT EXISTS stock_movements_salesman_product_idx ON public.stock_movements (salesman_id, product_id);
CREATE INDEX IF NOT EXISTS stock_movements_sale_kind_idx ON public.stock_movements (sale_id, kind);
CREATE INDEX IF NOT EXISTS imei_units_status_product_idx ON public.imei_units (status, product_id);
CREATE INDEX IF NOT EXISTS imei_units_salesman_status_idx ON public.imei_units (salesman_id, status);
CREATE INDEX IF NOT EXISTS sales_salesman_date_idx ON public.sales (salesman_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_retailer_date_idx ON public.sales (retailer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS retailer_payments_salesman_idx ON public.retailer_payments (salesman_id);
CREATE INDEX IF NOT EXISTS retailer_payments_retailer_date_idx ON public.retailer_payments (retailer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deposits_salesman_date_idx ON public.deposits (salesman_id, created_at DESC);
CREATE INDEX IF NOT EXISTS retailers_salesman_name_idx ON public.retailers (salesman_id, name);
CREATE OR REPLACE FUNCTION public.distribution_dashboard() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
WITH s AS (SELECT salesman_id, sum(total) total, sum(paid) paid FROM public.sales GROUP BY salesman_id),
p AS (SELECT salesman_id, sum(amount) amount FROM public.retailer_payments GROUP BY salesman_id),
d AS (SELECT salesman_id, sum(amount) amount FROM public.deposits GROUP BY salesman_id),
i AS (SELECT count(*) FILTER (WHERE status='in_stock') stock, count(*) FILTER (WHERE status='with_salesman') held, count(*) FILTER (WHERE status='damaged') damaged FROM public.imei_units)
SELECT jsonb_build_object('inStock',i.stock,'withSales',i.held,'damaged',i.damaged,
'salesTotal',coalesce((SELECT sum(total) FROM s),0),
'due',coalesce((SELECT sum(total-paid) FROM s),0)-coalesce((SELECT sum(amount) FROM p),0),
'deposited',coalesce((SELECT sum(amount) FROM d),0),
'salesBy',coalesce((SELECT jsonb_object_agg(salesman_id,total) FROM s),'{}'::jsonb),
'paidBy',coalesce((SELECT jsonb_object_agg(salesman_id,paid) FROM s),'{}'::jsonb),
'collectedBy',coalesce((SELECT jsonb_object_agg(salesman_id,amount) FROM p),'{}'::jsonb),
'depBy',coalesce((SELECT jsonb_object_agg(salesman_id,amount) FROM d),'{}'::jsonb)) FROM i;
$$;
REVOKE ALL ON FUNCTION public.distribution_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distribution_dashboard() TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.distribution_stock_counts() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
SELECT coalesce(jsonb_object_agg(product_id,n),'{}'::jsonb) FROM (SELECT product_id,count(*) n FROM public.imei_units WHERE status='in_stock' GROUP BY product_id) c;
$$;
REVOKE ALL ON FUNCTION public.distribution_stock_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distribution_stock_counts() TO authenticated, service_role;