CREATE TABLE public.dealer_risk_assessments (retailer_id uuid PRIMARY KEY REFERENCES public.retailers(id), score integer NOT NULL CHECK(score BETWEEN 0 AND 100), reason_bn text NOT NULL, reason_en text NOT NULL, action_bn text NOT NULL, action_en text NOT NULL, assessed_at timestamptz NOT NULL DEFAULT now(), assessed_by uuid NOT NULL, model text NOT NULL, facts jsonb NOT NULL);
GRANT SELECT,INSERT,UPDATE ON public.dealer_risk_assessments TO authenticated;
GRANT ALL ON public.dealer_risk_assessments TO service_role;
ALTER TABLE public.dealer_risk_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner risk access" ON public.dealer_risk_assessments TO authenticated USING(public.has_role(auth.uid(),'admin')) WITH CHECK(public.has_role(auth.uid(),'admin'));
CREATE TABLE public.dealer_blocks (retailer_id uuid PRIMARY KEY REFERENCES public.retailers(id), blocked boolean NOT NULL DEFAULT true, confirmed_by uuid NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.dealer_blocks TO authenticated;
GRANT ALL ON public.dealer_blocks TO service_role;
ALTER TABLE public.dealer_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read dealer block" ON public.dealer_blocks FOR SELECT TO authenticated USING(public.has_role(auth.uid(),'admin') OR EXISTS(SELECT 1 FROM public.retailers r WHERE r.id=retailer_id AND r.salesman_id=auth.uid()));
CREATE TABLE public.dealer_ai_access (id boolean PRIMARY KEY DEFAULT true CHECK(id), denial_message text NOT NULL, status integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.dealer_ai_access TO authenticated;
GRANT ALL ON public.dealer_ai_access TO service_role;
ALTER TABLE public.dealer_ai_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner AI state" ON public.dealer_ai_access TO authenticated USING(public.has_role(auth.uid(),'admin')) WITH CHECK(public.has_role(auth.uid(),'admin'));
CREATE FUNCTION public.set_dealer_block(_retailer uuid,_blocked boolean,_confirmed boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
 IF _confirmed IS DISTINCT FROM true THEN RAISE EXCEPTION 'Explicit owner confirmation required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.retailers WHERE id=_retailer) THEN RAISE EXCEPTION 'Dealer not found'; END IF;
 PERFORM 1 FROM public.retailers WHERE id=_retailer FOR UPDATE;
 INSERT INTO public.dealer_blocks(retailer_id,blocked,confirmed_by) VALUES(_retailer,_blocked,auth.uid()) ON CONFLICT(retailer_id) DO UPDATE SET blocked=EXCLUDED.blocked,confirmed_by=EXCLUDED.confirmed_by,confirmed_at=now();
END $$;
REVOKE ALL ON FUNCTION public.set_dealer_block(uuid,boolean,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_dealer_block(uuid,boolean,boolean) TO authenticated;
CREATE FUNCTION public.enforce_dealer_block() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM 1 FROM public.retailers WHERE id=NEW.retailer_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.dealer_blocks WHERE retailer_id=NEW.retailer_id AND blocked) THEN RAISE EXCEPTION 'Dealer blocked by owner. New sales are not allowed; payments remain available.'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dealer_block_sales BEFORE INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION public.enforce_dealer_block();
CREATE FUNCTION public.dealer_risk_history() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
 WITH payments AS(SELECT retailer_id,sum(amount) amount,max(created_at) last_payment,count(*) payment_count FROM retailer_payments GROUP BY retailer_id),
 invoices AS(SELECT s.*,coalesce(p.amount,0) payments,coalesce(sum(greatest(s.total-s.paid,0)) OVER(PARTITION BY s.retailer_id ORDER BY s.created_at,s.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior FROM sales s LEFT JOIN payments p ON p.retailer_id=s.retailer_id),
 balances AS(SELECT *,greatest(greatest(total-paid,0)-greatest(payments-prior,0),0) remaining FROM invoices),
 totals AS(SELECT retailer_id,count(*) invoice_count,sum(total) sales_total,sum(paid) paid_at_sale,sum(remaining) total_due,coalesce(sum(remaining) FILTER(WHERE created_at<=now()-interval '30 days'),0) overdue_amount,coalesce(extract(day FROM now()-min(created_at) FILTER(WHERE remaining>0))::int,0) age_days,max(created_at) last_sale FROM balances GROUP BY retailer_id),
 returns AS(SELECT retailer_id,sum(qty) return_qty,sum(qty*unit_price) return_value FROM stock_movements WHERE kind IN('return','damage') AND retailer_id IS NOT NULL GROUP BY retailer_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'phone',r.phone,'salesman_name',pr.full_name,'invoice_count',coalesce(t.invoice_count,0),'sales_total',coalesce(t.sales_total,0),'paid_at_sale',coalesce(t.paid_at_sale,0),'collected',coalesce(p.amount,0),'payment_count',coalesce(p.payment_count,0),'last_payment',p.last_payment,'last_sale',t.last_sale,'total_due',coalesce(t.total_due,0),'overdue_amount',coalesce(t.overdue_amount,0),'age_days',coalesce(t.age_days,0),'linked_return_qty',coalesce(rt.return_qty,0),'linked_return_value',coalesce(rt.return_value,0),'unattributed_return_count',(SELECT count(*) FROM stock_movements WHERE kind IN('return','damage') AND retailer_id IS NULL),'blocked',coalesce(b.blocked,false)) ORDER BY r.id),'[]'::jsonb) INTO result FROM retailers r LEFT JOIN profiles pr ON pr.id=r.salesman_id LEFT JOIN totals t ON t.retailer_id=r.id LEFT JOIN payments p ON p.retailer_id=r.id LEFT JOIN returns rt ON rt.retailer_id=r.id LEFT JOIN dealer_blocks b ON b.retailer_id=r.id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.dealer_risk_history() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dealer_risk_history() TO authenticated;