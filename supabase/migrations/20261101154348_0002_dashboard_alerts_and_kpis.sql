ALTER TABLE public.products ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0);
COMMENT ON COLUMN public.products.low_stock_threshold IS 'Per-product warning threshold. Zero disables alerts until the owner configures a limit.';
CREATE OR REPLACE FUNCTION public.distribution_insights() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
WITH payment_totals AS (SELECT retailer_id,sum(amount) amount FROM public.retailer_payments GROUP BY retailer_id),
invoice_balances AS (
 SELECT s.id,s.retailer_id,s.created_at,greatest(s.total-s.paid,0) balance,
 coalesce(p.amount,0) payments,
 coalesce(sum(greatest(s.total-s.paid,0)) OVER (PARTITION BY s.retailer_id ORDER BY s.created_at,s.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior_balance
 FROM public.sales s LEFT JOIN payment_totals p ON p.retailer_id=s.retailer_id
), outstanding AS (
 SELECT *, greatest(balance-greatest(payments-prior_balance,0),0) remaining FROM invoice_balances
), aged AS (
 SELECT retailer_id,sum(remaining) total_due,
 sum(remaining) FILTER (WHERE created_at <= now()-interval '30 days') overdue_amount,
 min(created_at) FILTER (WHERE remaining>0) oldest
 FROM outstanding GROUP BY retailer_id HAVING sum(remaining)>0
), overdue AS (
 SELECT r.id,r.name,r.phone,r.address,r.salesman_id,p.full_name salesman_name,
 a.total_due,a.overdue_amount,extract(day FROM now()-a.oldest)::integer age_days
 FROM aged a JOIN public.retailers r ON r.id=a.retailer_id LEFT JOIN public.profiles p ON p.id=r.salesman_id
 WHERE a.overdue_amount>0 ORDER BY a.oldest,r.name
), stock AS (
 SELECT p.id,p.name,p.model,p.price,p.low_stock_threshold,
 CASE WHEN p.is_smartphone THEN (SELECT count(*) FROM public.imei_units i WHERE i.product_id=p.id AND i.status='in_stock') ELSE p.stock_qty END qty
 FROM public.products p
), moves AS (
 SELECT coalesce(sum(CASE WHEN kind='issue' THEN qty ELSE -qty END),0) held,
 coalesce(sum(CASE WHEN kind='issue' THEN qty*unit_price ELSE -qty*unit_price END),0) held_value,
 coalesce(sum(qty) FILTER (WHERE kind='return'),0) returned,
 coalesce(sum(qty) FILTER (WHERE kind='damage'),0) damaged
 FROM public.stock_movements
), sales_kpis AS (
 SELECT coalesce(sum(total),0) total,coalesce(sum(paid),0) paid,
 coalesce(sum(total) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Dhaka')::date=(now() AT TIME ZONE 'Asia/Dhaka')::date),0) today_sales,
 coalesce(sum(total) FILTER (WHERE date_trunc('month',created_at AT TIME ZONE 'Asia/Dhaka')=date_trunc('month',now() AT TIME ZONE 'Asia/Dhaka')),0) month_sales,
 count(*) invoices FROM public.sales
), totals AS (
 SELECT coalesce((SELECT sum(amount) FROM public.retailer_payments),0) collected,
 coalesce((SELECT sum(amount) FROM public.deposits),0) deposited
)
SELECT jsonb_build_object(
 'overdue',coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.age_days DESC,o.name) FROM overdue o),'[]'::jsonb),
 'overdueTotal',coalesce((SELECT sum(overdue_amount) FROM overdue),0),
 'lowStock',CASE WHEN public.has_role(auth.uid(),'admin') THEN coalesce((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.qty,st.name) FROM stock st WHERE st.qty<st.low_stock_threshold),'[]'::jsonb) ELSE '[]'::jsonb END,
 'warehouseQty',CASE WHEN public.has_role(auth.uid(),'admin') THEN (SELECT coalesce(sum(qty),0) FROM stock) ELSE NULL END,
 'warehouseValue',CASE WHEN public.has_role(auth.uid(),'admin') THEN (SELECT coalesce(sum(qty*price),0) FROM stock) ELSE NULL END,
 'todaySales',s.today_sales,'monthSales',s.month_sales,'salesTotal',s.total,'invoiceCount',s.invoices,
 'collected',s.paid+t.collected,'cashInHand',s.paid+t.collected-t.deposited,'deposited',t.deposited,
 'retailerDue',s.total-s.paid-t.collected,'heldQty',m.held,'heldValue',m.held_value,'returnedQty',m.returned,'damagedQty',m.damaged,
 'retailerCount',(SELECT count(*) FROM public.retailers),
 'activeSalesmen',(SELECT count(*) FROM public.profiles pr JOIN public.user_roles ur ON ur.user_id=pr.id WHERE ur.role='salesman' AND pr.active)
) FROM moves m CROSS JOIN sales_kpis s CROSS JOIN totals t;
$$;
REVOKE ALL ON FUNCTION public.distribution_insights() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.distribution_insights() TO authenticated,service_role;