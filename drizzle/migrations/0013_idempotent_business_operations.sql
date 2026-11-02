CREATE TABLE public.business_operation_receipts (
  operation_id uuid PRIMARY KEY,
  actor uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.business_operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.business_operation_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.business_operation_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.perform_business_operation(
  _operation_id uuid,
  _kind text,
  _payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  existing_actor uuid;
  existing_kind text;
  existing_request_hash text;
  existing_result jsonb;
  operation_result jsonb;
  inserted_rows integer;
  record_id uuid;
  target_salesman uuid;
  target_retailer uuid;
  amount numeric;
BEGIN
  IF current_user_id IS NULL OR NOT public.user_is_active(current_user_id) THEN
    RAISE EXCEPTION 'Account inactive or unauthenticated';
  END IF;
  IF _operation_id IS NULL THEN RAISE EXCEPTION 'Operation ID is required'; END IF;
  IF _payload IS NULL OR jsonb_typeof(_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Operation payload must be an object';
  END IF;

  INSERT INTO public.business_operation_receipts(operation_id, actor, kind, request_hash, result)
  VALUES (_operation_id, current_user_id, _kind, md5(_kind || ':' || _payload::text), '{}'::jsonb)
  ON CONFLICT (operation_id) DO NOTHING;
  GET DIAGNOSTICS inserted_rows = ROW_COUNT;

  IF inserted_rows = 0 THEN
    SELECT actor, kind, request_hash, result
      INTO existing_actor, existing_kind, existing_request_hash, existing_result
      FROM public.business_operation_receipts
      WHERE operation_id = _operation_id
      FOR UPDATE;
    IF existing_actor IS DISTINCT FROM current_user_id
       OR existing_kind IS DISTINCT FROM _kind
       OR existing_request_hash IS DISTINCT FROM md5(_kind || ':' || _payload::text) THEN
      RAISE EXCEPTION 'Operation ID already belongs to a different request';
    END IF;
    RETURN existing_result;
  END IF;

  CASE _kind
    WHEN 'record_sale' THEN
      record_id := public.record_sale(
        (_payload ->> '_retailer')::uuid,
        _payload -> '_items',
        (_payload ->> '_paid')::numeric
      );
      operation_result := jsonb_build_object('id', record_id);
    WHEN 'issue_stock' THEN
      PERFORM public.issue_stock(
        (_payload ->> '_salesman')::uuid,
        _payload -> '_items'
      );
      operation_result := jsonb_build_object('ok', true);
    WHEN 'return_stock' THEN
      PERFORM public.return_stock(
        (_payload ->> '_salesman')::uuid,
        _payload -> '_items'
      );
      operation_result := jsonb_build_object('ok', true);
    WHEN 'retailer_payment' THEN
      target_retailer := (_payload ->> 'retailer_id')::uuid;
      amount := (_payload ->> 'amount')::numeric;
      IF NOT public.user_can(current_user_id, 'collect_payment') THEN
        RAISE EXCEPTION 'Collection permission denied';
      END IF;
      IF NOT public.has_role(current_user_id, 'admin')
         AND NOT EXISTS (
           SELECT 1 FROM public.retailers
           WHERE id = target_retailer AND salesman_id = current_user_id
         ) THEN
        RAISE EXCEPTION 'Retailer not yours';
      END IF;
      INSERT INTO public.retailer_payments(retailer_id, amount, note)
      VALUES (target_retailer, amount, nullif(_payload ->> 'note', ''))
      RETURNING id INTO record_id;
      operation_result := jsonb_build_object('id', record_id);
    WHEN 'deposit' THEN
      IF NOT public.has_role(current_user_id, 'admin') THEN
        RAISE EXCEPTION 'Owner only';
      END IF;
      target_salesman := (_payload ->> 'salesman_id')::uuid;
      IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = target_salesman AND role = 'salesman'
      ) THEN
        RAISE EXCEPTION 'Salesman not found';
      END IF;
      amount := (_payload ->> 'amount')::numeric;
      INSERT INTO public.deposits(salesman_id, amount, note, received_by)
      VALUES (target_salesman, amount, nullif(_payload ->> 'note', ''), current_user_id)
      RETURNING id INTO record_id;
      operation_result := jsonb_build_object('id', record_id);
    WHEN 'add_retailer' THEN
      target_salesman := (_payload ->> 'salesman_id')::uuid;
      IF nullif(btrim(_payload ->> 'name'), '') IS NULL THEN
        RAISE EXCEPTION 'Retailer name is required';
      END IF;
      IF NOT public.user_can(current_user_id, 'retailer_manage') THEN
        RAISE EXCEPTION 'Retailer management permission denied';
      END IF;
      IF public.has_role(current_user_id, 'admin') THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = target_salesman AND active
        ) OR NOT EXISTS (
          SELECT 1 FROM public.user_roles
          WHERE user_id = target_salesman AND role = 'salesman'
        ) THEN
          RAISE EXCEPTION 'Active salesman not found';
        END IF;
      ELSIF target_salesman IS DISTINCT FROM current_user_id THEN
        RAISE EXCEPTION 'Salesmen can only add retailers to their own account';
      END IF;
      INSERT INTO public.retailers(salesman_id, name, phone, address)
      VALUES (
        target_salesman,
        btrim(_payload ->> 'name'),
        nullif(btrim(_payload ->> 'phone'), ''),
        nullif(btrim(_payload ->> 'address'), '')
      )
      RETURNING id INTO record_id;
      operation_result := jsonb_build_object('id', record_id);
    ELSE
      RAISE EXCEPTION 'Unsupported business operation';
  END CASE;

  UPDATE public.business_operation_receipts
  SET result = operation_result
  WHERE operation_id = _operation_id;

  RETURN operation_result;
END;
$$;
REVOKE ALL ON FUNCTION public.perform_business_operation(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.perform_business_operation(uuid, text, jsonb) TO authenticated, service_role;
