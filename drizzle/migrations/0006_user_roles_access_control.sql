CREATE TABLE public.user_permission_overrides (user_id uuid PRIMARY KEY REFERENCES public.profiles(id), permissions jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL);
GRANT SELECT ON public.user_permission_overrides TO authenticated; GRANT ALL ON public.user_permission_overrides TO service_role;
ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_own_permissions ON public.user_permission_overrides FOR SELECT TO authenticated USING(user_id=auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE FUNCTION public.user_is_active(_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM profiles WHERE id=_user AND active); $$;
REVOKE ALL ON FUNCTION public.user_is_active(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.user_is_active(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid,_role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM user_roles r JOIN profiles p ON p.id=r.user_id WHERE r.user_id=_user_id AND r.role=_role AND p.active); $$;
CREATE FUNCTION public.user_can(_user uuid,_permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.user_is_active(_user) AND (public.has_role(_user,'admin') OR (public.has_role(_user,'salesman') AND _permission IN ('sales','returns','retailer_manage','collect_payment') AND coalesce((SELECT (permissions->>_permission)::boolean FROM user_permission_overrides WHERE user_id=_user),true))); $$;
REVOKE ALL ON FUNCTION public.user_can(uuid,text) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.user_can(uuid,text) TO authenticated;
-- A restrictive policy intersects all existing row-scoped policies; inactive users cannot access business data.
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['products','retailers','sales','stock_movements','imei_units','retailer_payments','deposits','dealer_blocks','dealer_risk_assessments','dealer_ai_access','business_audit','business_exports','user_roles','user_permission_overrides'] LOOP EXECUTE format('CREATE POLICY active_account_required ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.user_is_active(auth.uid())) WITH CHECK (public.user_is_active(auth.uid()))',t); END LOOP; END $$;
CREATE POLICY retailer_action_permission ON public.retailers AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK(public.user_can(auth.uid(),'retailer_manage'));
CREATE POLICY retailer_update_permission ON public.retailers AS RESTRICTIVE FOR UPDATE TO authenticated USING(public.user_can(auth.uid(),'retailer_manage')) WITH CHECK(public.user_can(auth.uid(),'retailer_manage'));
CREATE POLICY collection_action_permission ON public.retailer_payments AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK(public.user_can(auth.uid(),'collect_payment'));
CREATE FUNCTION public.guard_profile_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
IF NEW.active IS DISTINCT FROM OLD.active THEN
 PERFORM pg_advisory_xact_lock(9142026);
 IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Only owner can change account access'; END IF;
 IF OLD.id=auth.uid() THEN RAISE EXCEPTION 'Cannot disable your own account'; END IF;
END IF; RETURN NEW; END; $$;
CREATE TRIGGER profile_access_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.guard_profile_access();
CREATE FUNCTION public.guard_business_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE target uuid; permission text; BEGIN
IF auth.uid() IS NULL OR NOT public.user_is_active(auth.uid()) THEN RAISE EXCEPTION 'Account inactive or unauthenticated'; END IF;
IF TG_TABLE_NAME='stock_movements' THEN
 IF TG_OP='INSERT' THEN target:=NEW.salesman_id; IF NOT public.user_is_active(target) THEN RAISE EXCEPTION 'Target account inactive'; END IF;
 permission:=CASE WHEN NEW.kind='sale' THEN 'sales' WHEN NEW.kind IN ('return','damage') THEN 'returns' ELSE 'issue_stock' END;
 IF NOT public.user_can(auth.uid(),permission) THEN RAISE EXCEPTION 'Action permission denied'; END IF;
 END IF;
ELSIF TG_TABLE_NAME='sales' AND TG_OP='INSERT' THEN
 IF NOT public.user_can(auth.uid(),'sales') THEN RAISE EXCEPTION 'Sales permission denied'; END IF;
ELSIF TG_TABLE_NAME='retailers' THEN
 IF NOT public.user_can(auth.uid(),'retailer_manage') THEN RAISE EXCEPTION 'Retailer management permission denied'; END IF;
ELSIF TG_TABLE_NAME='retailer_payments' THEN
 IF NOT public.user_can(auth.uid(),'collect_payment') THEN RAISE EXCEPTION 'Collection permission denied'; END IF;
END IF;
IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END; $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['stock_movements','sales','retailers','retailer_payments','deposits','imei_units','products'] LOOP EXECUTE format('CREATE TRIGGER business_access_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_business_access()',t); END LOOP; END $$;
CREATE FUNCTION public.manage_user_access(_user uuid,_role public.app_role,_active boolean,_permissions jsonb,_reason text,_confirmed boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE old_data jsonb; k text; BEGIN
PERFORM pg_advisory_xact_lock(9142026);
IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
IF _confirmed IS DISTINCT FROM true OR coalesce(length(trim(_reason)),0)<3 THEN RAISE EXCEPTION 'Confirmation and reason required'; END IF;
IF _user=auth.uid() AND (_role<>'admin' OR NOT _active) THEN RAISE EXCEPTION 'Cannot remove your own owner access'; END IF;
IF _role IS NULL OR _active IS NULL OR jsonb_typeof(_permissions) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid access settings'; END IF;
FOR k IN SELECT jsonb_object_keys(_permissions) LOOP
 IF k NOT IN ('sales','returns','retailer_manage','collect_payment') OR jsonb_typeof(_permissions->k)<>'boolean' THEN RAISE EXCEPTION 'Invalid permission'; END IF;
END LOOP;
IF _role<>'admin' AND (EXISTS(SELECT 1 FROM retailers WHERE salesman_id=_user) OR EXISTS(SELECT 1 FROM stock_movements WHERE salesman_id=_user)) AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=_user AND role='admin') THEN RAISE EXCEPTION 'Reconcile owner assigned business history before demotion'; END IF;
PERFORM 1 FROM profiles WHERE id=_user FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
SELECT jsonb_build_object('profile',to_jsonb(p),'roles',(SELECT jsonb_agg(role) FROM user_roles WHERE user_id=_user),'permissions',(SELECT permissions FROM user_permission_overrides WHERE user_id=_user)) INTO old_data FROM profiles p WHERE p.id=_user;
UPDATE profiles SET active=_active WHERE id=_user;
DELETE FROM user_roles WHERE user_id=_user; INSERT INTO user_roles(user_id,role) VALUES(_user,_role);
INSERT INTO user_permission_overrides(user_id,permissions,updated_by) VALUES(_user,_permissions,auth.uid()) ON CONFLICT(user_id) DO UPDATE SET permissions=EXCLUDED.permissions,updated_by=EXCLUDED.updated_by,updated_at=now();
INSERT INTO business_audit(actor,action,entity,entity_id,reason,before_data,after_data) VALUES(auth.uid(),'access_change','user_roles',_user,_reason,old_data,jsonb_build_object('role',_role,'active',_active,'permissions',_permissions)); END; $$;
REVOKE ALL ON FUNCTION public.manage_user_access(uuid,public.app_role,boolean,jsonb,text,boolean) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.manage_user_access(uuid,public.app_role,boolean,jsonb,text,boolean) TO authenticated;