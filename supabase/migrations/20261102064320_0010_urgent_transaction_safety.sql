CREATE OR REPLACE FUNCTION public.record_sale(_retailer uuid, _items jsonb, _paid numeric) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  it jsonb;
  p record;
  im text;
  n numeric;
  changed integer;
  sid uuid;
  me uuid := auth.uid();
  retailer_salesman uuid;
  tot numeric := 0;
  price numeric;
BEGIN
  IF _paid IS NULL OR _paid < 0 THEN RAISE EXCEPTION 'Paid amount cannot be negative'; END IF;
  IF _items IS NULL OR jsonb_typeof(_items) IS DISTINCT FROM 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'At least one sale item is required';
  END IF;

  SELECT salesman_id INTO retailer_salesman
  FROM public.retailers
  WHERE id = _retailer
  FOR UPDATE;
  IF NOT FOUND OR retailer_salesman IS DISTINCT FROM me THEN RAISE EXCEPTION 'Retailer not yours'; END IF;

  PERFORM prod.id
  FROM public.products prod
  WHERE prod.id IN (
    SELECT DISTINCT (line->>'product_id')::uuid
    FROM jsonb_array_elements(_items) AS lines(line)
    WHERE jsonb_typeof(line) = 'object' AND jsonb_typeof(line->'product_id') = 'string'
  )
  ORDER BY prod.id
  FOR UPDATE;

  INSERT INTO public.sales(salesman_id, retailer_id, total, paid)
  VALUES (me, _retailer, 0, _paid)
  RETURNING id INTO sid;

  FOR it IN SELECT value FROM jsonb_array_elements(_items) LOOP
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' OR jsonb_typeof(it->'product_id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid sale item';
    END IF;

    SELECT * INTO p FROM public.products WHERE id = (it->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

    price := coalesce((it->>'unit_price')::numeric, p.price);
    IF price < 0 THEN RAISE EXCEPTION 'Unit price cannot be negative'; END IF;

    IF p.is_smartphone THEN
      IF jsonb_typeof(it->'imeis') IS DISTINCT FROM 'array' OR jsonb_array_length(it->'imeis') = 0
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(it->'imeis') AS items(value) WHERE jsonb_typeof(value) IS DISTINCT FROM 'string') THEN
        RAISE EXCEPTION 'Smartphone sale requires valid IMEIs';
      END IF;
      FOR im IN SELECT btrim(value) FROM jsonb_array_elements_text(it->'imeis') AS imeis(value) LOOP
        IF im = '' THEN RAISE EXCEPTION 'IMEI cannot be blank'; END IF;
        UPDATE public.imei_units
        SET status = 'sold', retailer_id = _retailer
        WHERE imei = im AND product_id = p.id AND status = 'with_salesman' AND salesman_id = me;
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed = 0 THEN RAISE EXCEPTION 'IMEI % not with you', im; END IF;
        INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,imei,sale_id,retailer_id)
        VALUES (me,p.id,'sale',1,price,im,sid,_retailer);
        tot := tot + price;
      END LOOP;
    ELSE
      IF jsonb_typeof(it->'qty') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
      n := (it->>'qty')::numeric;
      IF n <= 0 OR n <> trunc(n) OR n > 2147483647 THEN RAISE EXCEPTION 'Quantity must be a positive whole number'; END IF;
      IF public.holding_qty(me,p.id) < n THEN RAISE EXCEPTION 'Not enough % in hand', p.name; END IF;
      INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,sale_id,retailer_id)
      VALUES (me,p.id,'sale',n::integer,price,sid,_retailer);
      tot := tot + price*n;
    END IF;
  END LOOP;

  IF _paid > tot THEN RAISE EXCEPTION 'Paid more than total'; END IF;
  UPDATE public.sales SET total = tot WHERE id = sid;
  RETURN sid;
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_stock(_salesman uuid, _items jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  it jsonb;
  p record;
  im text;
  n numeric;
  changed integer;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  IF _items IS NULL OR jsonb_typeof(_items) IS DISTINCT FROM 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'At least one issue item is required';
  END IF;

  PERFORM prod.id
  FROM public.products prod
  WHERE prod.id IN (
    SELECT DISTINCT (line->>'product_id')::uuid
    FROM jsonb_array_elements(_items) AS lines(line)
    WHERE jsonb_typeof(line) = 'object' AND jsonb_typeof(line->'product_id') = 'string'
  )
  ORDER BY prod.id
  FOR UPDATE;

  FOR it IN SELECT value FROM jsonb_array_elements(_items) LOOP
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' OR jsonb_typeof(it->'product_id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid issue item';
    END IF;
    SELECT * INTO p FROM public.products WHERE id = (it->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

    IF p.is_smartphone THEN
      IF jsonb_typeof(it->'imeis') IS DISTINCT FROM 'array' OR jsonb_array_length(it->'imeis') = 0
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(it->'imeis') AS items(value) WHERE jsonb_typeof(value) IS DISTINCT FROM 'string') THEN
        RAISE EXCEPTION 'Smartphone issue requires valid IMEIs';
      END IF;
      FOR im IN SELECT btrim(value) FROM jsonb_array_elements_text(it->'imeis') AS imeis(value) LOOP
        UPDATE public.imei_units
        SET status = 'with_salesman', salesman_id = _salesman
        WHERE imei = im AND product_id = p.id AND status = 'in_stock';
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed = 0 THEN RAISE EXCEPTION 'IMEI % not available', im; END IF;
        INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,imei)
        VALUES (_salesman,p.id,'issue',1,p.price,im);
      END LOOP;
    ELSE
      IF jsonb_typeof(it->'qty') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
      n := (it->>'qty')::numeric;
      IF n <= 0 OR n <> trunc(n) OR n > 2147483647 THEN RAISE EXCEPTION 'Quantity must be a positive whole number'; END IF;
      IF p.stock_qty < n THEN RAISE EXCEPTION 'Not enough stock for %', p.name; END IF;
      UPDATE public.products SET stock_qty = stock_qty - n::integer WHERE id = p.id;
      INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price)
      VALUES (_salesman,p.id,'issue',n::integer,p.price);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_business_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  target uuid;
  permission text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_is_active(auth.uid()) THEN
    RAISE EXCEPTION 'Account inactive or unauthenticated';
  END IF;

  IF TG_TABLE_NAME = 'stock_movements' THEN
    IF TG_OP = 'INSERT' THEN
      target := NEW.salesman_id;
      permission := CASE WHEN NEW.kind = 'sale' THEN 'sales'
                         WHEN NEW.kind IN ('return','damage') THEN 'returns'
                         ELSE 'issue_stock' END;
      IF NEW.kind IN ('issue','sale') AND NOT public.user_is_active(target) THEN
        RAISE EXCEPTION 'Target account inactive';
      END IF;
      IF NEW.kind IN ('return','damage') AND target IS DISTINCT FROM auth.uid()
         AND NOT public.has_role(auth.uid(),'admin') THEN
        RAISE EXCEPTION 'Only the owner can settle another account';
      END IF;
      IF NOT public.user_can(auth.uid(),permission) THEN RAISE EXCEPTION 'Action permission denied'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'sales' AND TG_OP = 'INSERT' THEN
    IF NOT public.user_can(auth.uid(),'sales') THEN RAISE EXCEPTION 'Sales permission denied'; END IF;
  ELSIF TG_TABLE_NAME = 'retailers' THEN
    IF NOT public.user_can(auth.uid(),'retailer_manage') THEN RAISE EXCEPTION 'Retailer management permission denied'; END IF;
  ELSIF TG_TABLE_NAME = 'retailer_payments' THEN
    IF NOT public.user_can(auth.uid(),'collect_payment') THEN RAISE EXCEPTION 'Collection permission denied'; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_profile_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Only owner can change account access'; END IF;
    IF current_setting('app.manage_user_access',true) IS DISTINCT FROM 'enabled' THEN
      RAISE EXCEPTION 'Use the confirmed account access workflow';
    END IF;
    PERFORM pg_advisory_xact_lock(9142026);
    IF OLD.id = auth.uid() THEN RAISE EXCEPTION 'Cannot disable your own account'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.return_stock(_salesman uuid, _items jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  it jsonb;
  p record;
  im text;
  n numeric;
  changed integer;
  dmg boolean;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR _salesman = auth.uid()) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _items IS NULL OR jsonb_typeof(_items) IS DISTINCT FROM 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'At least one return item is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _salesman AND role = 'salesman') THEN
    RAISE EXCEPTION 'Salesman not found';
  END IF;

  FOR it IN SELECT value FROM jsonb_array_elements(_items) LOOP
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' OR jsonb_typeof(it->'product_id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid return item';
    END IF;
    SELECT * INTO p FROM public.products WHERE id = (it->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    dmg := coalesce((it->>'damaged')::boolean,false);

    IF p.is_smartphone THEN
      IF jsonb_typeof(it->'imeis') IS DISTINCT FROM 'array' OR jsonb_array_length(it->'imeis') = 0
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(it->'imeis') AS items(value) WHERE jsonb_typeof(value) IS DISTINCT FROM 'string') THEN
        RAISE EXCEPTION 'Smartphone return requires valid IMEIs';
      END IF;
      FOR im IN SELECT btrim(value) FROM jsonb_array_elements_text(it->'imeis') AS imeis(value) LOOP
        UPDATE public.imei_units
        SET status = CASE WHEN dmg THEN 'damaged'::public.imei_status ELSE 'in_stock'::public.imei_status END,
            salesman_id = NULL
        WHERE imei = im AND product_id = p.id AND status = 'with_salesman' AND salesman_id = _salesman;
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed = 0 THEN RAISE EXCEPTION 'IMEI % not with this salesman', im; END IF;
        INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,imei)
        VALUES (_salesman,p.id,CASE WHEN dmg THEN 'damage'::public.move_kind ELSE 'return'::public.move_kind END,1,p.price,im);
      END LOOP;
    ELSE
      IF jsonb_typeof(it->'qty') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
      n := (it->>'qty')::numeric;
      IF n <= 0 OR n <> trunc(n) OR n > 2147483647 THEN RAISE EXCEPTION 'Quantity must be a positive whole number'; END IF;
      IF public.holding_qty(_salesman,p.id) < n THEN RAISE EXCEPTION 'Return more than held for %', p.name; END IF;
      IF NOT dmg THEN UPDATE public.products SET stock_qty = stock_qty + n::integer WHERE id = p.id; END IF;
      INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price)
      VALUES (_salesman,p.id,CASE WHEN dmg THEN 'damage'::public.move_kind ELSE 'return'::public.move_kind END,n::integer,p.price);
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.receive_button_stock(_product uuid, _qty integer, _reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  p public.products%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  IF _qty IS NULL OR _qty <= 0 OR coalesce(length(trim(_reason)),0) < 3 THEN
    RAISE EXCEPTION 'Positive quantity and a reason are required';
  END IF;

  SELECT * INTO p FROM public.products WHERE id = _product FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF p.is_smartphone THEN RAISE EXCEPTION 'Smartphone stock must be registered by IMEI'; END IF;

  UPDATE public.products SET stock_qty = stock_qty + _qty WHERE id = _product;
  INSERT INTO public.business_audit(actor,action,entity,entity_id,reason,before_data,after_data)
  VALUES (
    auth.uid(),'stock_receive','products',_product,trim(_reason),
    jsonb_build_object('stock_qty',p.stock_qty),
    jsonb_build_object('stock_qty',p.stock_qty + _qty)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.receive_button_stock(uuid,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.receive_button_stock(uuid,integer,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.manage_user_access(
  _user uuid, _role public.app_role, _active boolean, _permissions jsonb, _reason text, _confirmed boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  old_data jsonb;
  k text;
  cash_balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(9142026);
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  IF _confirmed IS DISTINCT FROM true OR coalesce(length(trim(_reason)),0) < 3 THEN
    RAISE EXCEPTION 'Confirmation and reason required';
  END IF;
  IF _user = auth.uid() AND (_role <> 'admin' OR NOT _active) THEN RAISE EXCEPTION 'Cannot remove your own owner access'; END IF;
  IF _role IS NULL OR _active IS NULL OR jsonb_typeof(_permissions) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid access settings';
  END IF;
  FOR k IN SELECT jsonb_object_keys(_permissions) LOOP
    IF k NOT IN ('sales','returns','retailer_manage','collect_payment')
       OR jsonb_typeof(_permissions->k) <> 'boolean' THEN RAISE EXCEPTION 'Invalid permission'; END IF;
  END LOOP;
  PERFORM 1 FROM public.profiles WHERE id = _user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user AND role = 'admin')
     AND (_role <> 'admin' OR NOT _active)
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
       JOIN public.profiles pr ON pr.id = ur.user_id
       WHERE ur.role = 'admin' AND pr.active AND ur.user_id <> _user
     ) THEN
    RAISE EXCEPTION 'At least one active owner account must remain';
  END IF;

  IF NOT _active AND _role = 'salesman' THEN
    IF EXISTS (
      SELECT 1 FROM public.stock_movements
      WHERE salesman_id = _user
      GROUP BY product_id
      HAVING sum(CASE WHEN kind = 'issue' THEN qty ELSE -qty END) <> 0
    ) THEN RAISE EXCEPTION 'Return or reconcile held stock before deactivating this salesman'; END IF;

    SELECT coalesce((SELECT sum(paid) FROM public.sales WHERE salesman_id = _user),0)
         + coalesce((SELECT sum(amount) FROM public.retailer_payments WHERE salesman_id = _user),0)
         - coalesce((SELECT sum(amount) FROM public.deposits WHERE salesman_id = _user),0)
    INTO cash_balance;
    IF cash_balance <> 0 THEN RAISE EXCEPTION 'Reconcile salesman cash before deactivation'; END IF;
  END IF;

  SELECT jsonb_build_object(
    'profile',to_jsonb(p),
    'roles',(SELECT jsonb_agg(role) FROM public.user_roles WHERE user_id = _user),
    'permissions',(SELECT permissions FROM public.user_permission_overrides WHERE user_id = _user)
  ) INTO old_data
  FROM public.profiles p WHERE p.id = _user;

  PERFORM set_config('app.manage_user_access','enabled',true);
  UPDATE public.profiles SET active = _active WHERE id = _user;
  DELETE FROM public.user_roles WHERE user_id = _user;
  INSERT INTO public.user_roles(user_id,role) VALUES (_user,_role);
  INSERT INTO public.user_permission_overrides(user_id,permissions,updated_by)
  VALUES (_user,_permissions,auth.uid())
  ON CONFLICT(user_id) DO UPDATE
    SET permissions = EXCLUDED.permissions, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO public.business_audit(actor,action,entity,entity_id,reason,before_data,after_data)
  VALUES (
    auth.uid(),'access_change','user_roles',_user,_reason,old_data,
    jsonb_build_object('role',_role,'active',_active,'permissions',_permissions)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.manage_user_access(uuid,public.app_role,boolean,jsonb,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_user_access(uuid,public.app_role,boolean,jsonb,text,boolean) TO authenticated;
