CREATE FUNCTION public.cancel_business_history(_table text,_id uuid,_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE r record; m record; p record; old jsonb; BEGIN
IF NOT public.has_role(auth.uid(),'admin') OR length(trim(_reason))<3 THEN RAISE EXCEPTION 'Owner and reason required'; END IF;
LOCK TABLE products,retailers,imei_units,sales,stock_movements,retailer_payments,deposits,dealer_blocks,dealer_risk_assessments IN SHARE ROW EXCLUSIVE MODE;
IF _table='sales' THEN
 SELECT * INTO r FROM sales WHERE id=_id FOR UPDATE; IF r.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
 IF EXISTS(SELECT 1 FROM retailer_payments WHERE retailer_id=r.retailer_id) THEN RAISE EXCEPTION 'Retailer has payments; reconcile them before cancelling invoice'; END IF;
 old:=jsonb_build_object('sale',to_jsonb(r),'items',(SELECT jsonb_agg(to_jsonb(t)) FROM stock_movements t WHERE sale_id=_id));
 FOR m IN SELECT * FROM stock_movements WHERE sale_id=_id LOOP
 IF m.imei IS NOT NULL THEN
 IF EXISTS(SELECT 1 FROM stock_movements WHERE imei=m.imei AND created_at>m.created_at) THEN RAISE EXCEPTION 'Later IMEI history prevents cancellation'; END IF;
 UPDATE imei_units SET status='with_salesman',retailer_id=NULL WHERE imei=m.imei AND status='sold' AND salesman_id=m.salesman_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
 END IF;
 END LOOP;
 DELETE FROM stock_movements WHERE sale_id=_id; DELETE FROM sales WHERE id=_id;
ELSIF _table='stock_movements' THEN
 SELECT * INTO m FROM stock_movements WHERE id=_id FOR UPDATE; IF m.id IS NULL THEN RAISE EXCEPTION 'Movement not found'; END IF;
 IF m.kind='sale' THEN RAISE EXCEPTION 'Cancel the whole invoice instead'; END IF;
 IF EXISTS(SELECT 1 FROM stock_movements WHERE salesman_id=m.salesman_id AND product_id=m.product_id AND (created_at>m.created_at OR (created_at=m.created_at AND id<>m.id))) THEN RAISE EXCEPTION 'Later stock history prevents cancellation'; END IF;
 SELECT * INTO p FROM products WHERE id=m.product_id FOR UPDATE;
 old:=to_jsonb(m);
 IF m.imei IS NOT NULL THEN
 IF m.kind='issue' THEN
 UPDATE imei_units SET status='in_stock',salesman_id=NULL,retailer_id=NULL WHERE imei=m.imei AND status='with_salesman' AND salesman_id=m.salesman_id;
 ELSE
 UPDATE imei_units SET status='with_salesman',salesman_id=m.salesman_id,retailer_id=NULL WHERE imei=m.imei AND status=(CASE WHEN m.kind='damage' THEN 'damaged'::imei_status ELSE 'in_stock'::imei_status END) AND salesman_id IS NULL;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
 ELSE
 IF m.kind='issue' THEN
 IF public.holding_qty(m.salesman_id,m.product_id)<m.qty THEN RAISE EXCEPTION 'Issued stock no longer in hand'; END IF;
 UPDATE products SET stock_qty=stock_qty+m.qty WHERE id=m.product_id;
 ELSIF m.kind='return' THEN
 IF p.stock_qty<m.qty THEN RAISE EXCEPTION 'Returned stock no longer available'; END IF;
 UPDATE products SET stock_qty=stock_qty-m.qty WHERE id=m.product_id;
 END IF;
 END IF;
 DELETE FROM stock_movements WHERE id=_id;
ELSE RAISE EXCEPTION 'Unsupported history'; END IF;
INSERT INTO business_audit(actor,action,entity,entity_id,reason,before_data) VALUES(auth.uid(),'cancel',_table,_id,_reason,old);
END; $$;
REVOKE ALL ON FUNCTION public.cancel_business_history(text,uuid,text) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.cancel_business_history(text,uuid,text) TO authenticated;