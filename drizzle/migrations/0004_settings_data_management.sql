CREATE TABLE public.business_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor uuid NOT NULL, action text NOT NULL, entity text, entity_id uuid, reason text, before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.business_audit TO authenticated; GRANT ALL ON public.business_audit TO service_role;
ALTER TABLE public.business_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_audit_read ON public.business_audit FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE TABLE public.business_exports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor uuid NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.business_exports TO authenticated; GRANT ALL ON public.business_exports TO service_role;
ALTER TABLE public.business_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_export_read ON public.business_exports FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') AND actor=auth.uid());
CREATE FUNCTION public.business_snapshot() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
SELECT jsonb_build_object('products',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM products t),'retailers',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM retailers t),'imei_units',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM imei_units t),'sales',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM sales t),'stock_movements',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM stock_movements t),'retailer_payments',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM retailer_payments t),'deposits',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM deposits t),'dealer_blocks',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY retailer_id),'[]') FROM dealer_blocks t),'dealer_risk_assessments',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY retailer_id),'[]') FROM dealer_risk_assessments t)); $$;
REVOKE ALL ON FUNCTION public.business_snapshot() FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.export_business_data() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE snap jsonb; bid uuid; BEGIN
IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
LOCK TABLE products,retailers,imei_units,sales,stock_movements,retailer_payments,deposits,dealer_blocks,dealer_risk_assessments IN SHARE MODE;
snap:=public.business_snapshot(); IF octet_length(snap::text)>20971520 THEN RAISE EXCEPTION 'Use Cloud export for data larger than 20 MB'; END IF;
INSERT INTO business_exports(actor,snapshot) VALUES(auth.uid(),snap) RETURNING id INTO bid;
RETURN jsonb_build_object('format','firoza-business-data','version',1,'source',bid,'exported_at',now(),'tables',snap); END; $$;
REVOKE ALL ON FUNCTION public.export_business_data() FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.export_business_data() TO authenticated;
CREATE FUNCTION public.reset_business_data(_confirmation text,_backup_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE snap jsonb; BEGIN
IF NOT public.has_role(auth.uid(),'admin') OR _confirmation IS DISTINCT FROM 'RESET FIROZA' THEN RAISE EXCEPTION 'Owner confirmation required'; END IF;
LOCK TABLE products,retailers,imei_units,sales,stock_movements,retailer_payments,deposits,dealer_blocks,dealer_risk_assessments IN ACCESS EXCLUSIVE MODE;
SELECT snapshot INTO snap FROM business_exports WHERE id=_backup_id AND actor=auth.uid() AND created_at>now()-interval '30 minutes';
IF snap IS NULL OR snap IS DISTINCT FROM public.business_snapshot() THEN RAISE EXCEPTION 'Download a fresh backup first; data may have changed'; END IF;
DELETE FROM dealer_risk_assessments WHERE retailer_id IS NOT NULL; DELETE FROM dealer_blocks WHERE retailer_id IS NOT NULL;
DELETE FROM stock_movements WHERE id IS NOT NULL; DELETE FROM retailer_payments WHERE id IS NOT NULL; DELETE FROM deposits WHERE id IS NOT NULL; DELETE FROM sales WHERE id IS NOT NULL; DELETE FROM imei_units WHERE id IS NOT NULL; DELETE FROM retailers WHERE id IS NOT NULL; DELETE FROM products WHERE id IS NOT NULL;
INSERT INTO business_audit(actor,action,reason,before_data) VALUES(auth.uid(),'reset','RESET FIROZA',jsonb_build_object('backup_id',_backup_id)); END; $$;
REVOKE ALL ON FUNCTION public.reset_business_data(text,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.reset_business_data(text,uuid) TO authenticated;
CREATE FUNCTION public.restore_business_data(_confirmation text,_snapshot jsonb,_backup_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE tab text; row_data jsonb; saved jsonb; BEGIN
IF NOT public.has_role(auth.uid(),'admin') OR _confirmation IS DISTINCT FROM 'RESTORE FIROZA' THEN RAISE EXCEPTION 'Owner confirmation required'; END IF;
IF _snapshot->>'format' IS DISTINCT FROM 'firoza-business-data' OR _snapshot->>'version' IS DISTINCT FROM '1' OR octet_length(_snapshot::text)>20971520 THEN RAISE EXCEPTION 'Invalid backup format or size'; END IF;
-- Only authentic exports from this database are eligible, preventing fabricated stock/account histories.
SELECT snapshot INTO saved FROM business_exports WHERE id=(_snapshot->>'source')::uuid;
IF saved IS NULL OR saved IS DISTINCT FROM _snapshot->'tables' THEN RAISE EXCEPTION 'Backup is modified or belongs to another installation'; END IF;
PERFORM public.reset_business_data('RESET FIROZA',_backup_id);
INSERT INTO products SELECT * FROM jsonb_populate_recordset(NULL::public.products,saved->'products');
INSERT INTO retailers SELECT * FROM jsonb_populate_recordset(NULL::public.retailers,saved->'retailers');
INSERT INTO imei_units SELECT * FROM jsonb_populate_recordset(NULL::public.imei_units,saved->'imei_units');
-- Restore sales before blocks so the sales-insert protection remains untouched.
INSERT INTO sales SELECT * FROM jsonb_populate_recordset(NULL::public.sales,saved->'sales');
INSERT INTO stock_movements SELECT * FROM jsonb_populate_recordset(NULL::public.stock_movements,saved->'stock_movements');
INSERT INTO retailer_payments SELECT * FROM jsonb_populate_recordset(NULL::public.retailer_payments,saved->'retailer_payments');
INSERT INTO deposits SELECT * FROM jsonb_populate_recordset(NULL::public.deposits,saved->'deposits');
-- AI advice and blocking are not restored: every block requires a new explicit dealer confirmation.
INSERT INTO business_audit(actor,action,reason,after_data) VALUES(auth.uid(),'restore','RESTORE FIROZA',jsonb_build_object('source',_snapshot->>'source','safety_backup',_backup_id)); END; $$;
REVOKE ALL ON FUNCTION public.restore_business_data(text,jsonb,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.restore_business_data(text,jsonb,uuid) TO authenticated;
CREATE FUNCTION public.manage_business_record(_table text,_id uuid,_action text,_values jsonb,_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE old jsonb; updated jsonb; owner boolean:=public.has_role(auth.uid(),'admin'); r record; BEGIN
IF auth.uid() IS NULL OR length(trim(_reason))<3 OR _action NOT IN ('update','delete') THEN RAISE EXCEPTION 'Valid reason and authentication required'; END IF;
IF NOT owner AND _table<>'retailers' THEN RAISE EXCEPTION 'Owner only'; END IF;
IF _table='products' THEN
 SELECT to_jsonb(p) INTO old FROM products p WHERE id=_id FOR UPDATE;
 IF _action='delete' THEN
 IF EXISTS(SELECT 1 FROM stock_movements WHERE product_id=_id) OR EXISTS(SELECT 1 FROM imei_units WHERE product_id=_id) OR coalesce((old->>'stock_qty')::int,0)<>0 THEN RAISE EXCEPTION 'Product has stock or history; cannot delete'; END IF;
 DELETE FROM products WHERE id=_id;
 ELSE
 IF length(trim(_values->>'name'))=0 OR (_values->>'price')::numeric<0 THEN RAISE EXCEPTION 'Invalid product name or price'; END IF;
 UPDATE products SET name=trim(_values->>'name'),model=nullif(_values->>'model',''),price=(_values->>'price')::numeric WHERE id=_id RETURNING to_jsonb(products.*) INTO updated;
 END IF;
ELSIF _table='retailers' THEN
 SELECT to_jsonb(t) INTO old FROM retailers t WHERE id=_id AND (owner OR salesman_id=auth.uid()) FOR UPDATE;
 IF old IS NULL THEN RAISE EXCEPTION 'Retailer not available'; END IF;
 IF _action='delete' THEN
 IF EXISTS(SELECT 1 FROM sales WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM retailer_payments WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM stock_movements WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM dealer_blocks WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM dealer_risk_assessments WHERE retailer_id=_id) THEN RAISE EXCEPTION 'Retailer has history; cannot delete'; END IF;
 DELETE FROM retailers WHERE id=_id;
 ELSE
 IF length(trim(_values->>'name'))=0 THEN RAISE EXCEPTION 'Name required'; END IF;
 UPDATE retailers SET name=trim(_values->>'name'),phone=_values->>'phone',address=_values->>'address' WHERE id=_id RETURNING to_jsonb(retailers.*) INTO updated;
 END IF;
ELSIF _table='profiles' THEN
 SELECT to_jsonb(p) INTO old FROM profiles p WHERE id=_id FOR UPDATE;
 IF NOT public.has_role(_id,'salesman') THEN RAISE EXCEPTION 'Only salesman profiles can be managed'; END IF;
 IF _action='delete' THEN
 IF EXISTS(SELECT 1 FROM stock_movements WHERE salesman_id=_id) OR EXISTS(SELECT 1 FROM sales WHERE salesman_id=_id) OR EXISTS(SELECT 1 FROM retailers WHERE salesman_id=_id) OR EXISTS(SELECT 1 FROM deposits WHERE salesman_id=_id) THEN RAISE EXCEPTION 'Salesman has history; reconcile and deactivate instead'; END IF;
 UPDATE profiles SET active=false WHERE id=_id RETURNING to_jsonb(profiles.*) INTO updated;
 ELSE
 IF length(trim(_values->>'full_name'))=0 THEN RAISE EXCEPTION 'Name required'; END IF;
 UPDATE profiles SET full_name=trim(_values->>'full_name'),phone=_values->>'phone' WHERE id=_id RETURNING to_jsonb(profiles.*) INTO updated;
 END IF;
ELSIF _table IN ('sales','stock_movements') THEN
 RAISE EXCEPTION 'Stock and sales history cannot be rewritten; use validated sale/return/issue functions';
ELSIF _table IN ('retailer_payments','deposits') THEN
 IF _table='retailer_payments' THEN
 SELECT * INTO r FROM retailer_payments WHERE id=_id FOR UPDATE; old:=to_jsonb(r);
 IF _action='delete' THEN DELETE FROM retailer_payments WHERE id=_id;
 ELSE
 IF (_values->>'amount')::numeric<=0 OR (_values->>'amount') IS NULL THEN RAISE EXCEPTION 'Positive amount required'; END IF;
 IF (_values->>'amount')::numeric>(SELECT coalesce(sum(total-paid),0) FROM sales WHERE retailer_id=r.retailer_id)-(SELECT coalesce(sum(amount),0) FROM retailer_payments WHERE retailer_id=r.retailer_id AND id<>_id) THEN RAISE EXCEPTION 'Amount exceeds retailer due'; END IF;
 UPDATE retailer_payments SET amount=(_values->>'amount')::numeric,note=_values->>'note' WHERE id=_id RETURNING to_jsonb(retailer_payments.*) INTO updated;
 END IF;
 ELSE
 SELECT * INTO r FROM deposits WHERE id=_id FOR UPDATE; old:=to_jsonb(r);
 IF _action='delete' THEN DELETE FROM deposits WHERE id=_id;
 ELSE
 IF (_values->>'amount')::numeric<=0 OR (_values->>'amount') IS NULL THEN RAISE EXCEPTION 'Positive amount required'; END IF;
 UPDATE deposits SET amount=(_values->>'amount')::numeric,note=_values->>'note' WHERE id=_id RETURNING to_jsonb(deposits.*) INTO updated;
 END IF;
 END IF;
ELSIF _table='imei_units' THEN
 SELECT to_jsonb(t) INTO old FROM imei_units t WHERE id=_id FOR UPDATE;
 IF old->>'status'<>'in_stock' OR EXISTS(SELECT 1 FROM stock_movements WHERE imei=old->>'imei') THEN RAISE EXCEPTION 'IMEI has history or is not in stock'; END IF;
 IF _action<>'delete' THEN RAISE EXCEPTION 'Delete unused IMEI then register the correct IMEI'; END IF;
 DELETE FROM imei_units WHERE id=_id;
ELSE RAISE EXCEPTION 'Unsupported list'; END IF;
IF old IS NULL THEN RAISE EXCEPTION 'Record not found'; END IF;
INSERT INTO business_audit(actor,action,entity,entity_id,reason,before_data,after_data) VALUES(auth.uid(),_action,_table,_id,_reason,old,updated);
END; $$;
REVOKE ALL ON FUNCTION public.manage_business_record(text,uuid,text,jsonb,text) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.manage_business_record(text,uuid,text,jsonb,text) TO authenticated;