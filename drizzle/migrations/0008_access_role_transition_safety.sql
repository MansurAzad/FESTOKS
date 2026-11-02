CREATE OR REPLACE FUNCTION public.manage_user_access(_user uuid,_role public.app_role,_active boolean,_permissions jsonb,_reason text,_confirmed boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE old_data jsonb; k text; BEGIN
PERFORM pg_advisory_xact_lock(9142026);
IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
IF _confirmed IS DISTINCT FROM true OR coalesce(length(trim(_reason)),0)<3 THEN RAISE EXCEPTION 'Confirmation and reason required'; END IF;
IF _user=auth.uid() AND (_role<>'admin' OR NOT _active) THEN RAISE EXCEPTION 'Cannot remove your own owner access'; END IF;
IF _role IS NULL OR _active IS NULL OR jsonb_typeof(_permissions) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid access settings'; END IF;
FOR k IN SELECT jsonb_object_keys(_permissions) LOOP IF k NOT IN ('sales','returns','retailer_manage','collect_payment') OR jsonb_typeof(_permissions->k)<>'boolean' THEN RAISE EXCEPTION 'Invalid permission'; END IF; END LOOP;
PERFORM 1 FROM profiles WHERE id=_user FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
SELECT jsonb_build_object('profile',to_jsonb(p),'roles',(SELECT jsonb_agg(role) FROM user_roles WHERE user_id=_user),'permissions',(SELECT permissions FROM user_permission_overrides WHERE user_id=_user)) INTO old_data FROM profiles p WHERE p.id=_user;
UPDATE profiles SET active=_active WHERE id=_user;
DELETE FROM user_roles WHERE user_id=_user; INSERT INTO user_roles(user_id,role) VALUES(_user,_role);
INSERT INTO user_permission_overrides(user_id,permissions,updated_by) VALUES(_user,_permissions,auth.uid()) ON CONFLICT(user_id) DO UPDATE SET permissions=EXCLUDED.permissions,updated_by=EXCLUDED.updated_by,updated_at=now();
INSERT INTO business_audit(actor,action,entity,entity_id,reason,before_data,after_data) VALUES(auth.uid(),'access_change','user_roles',_user,_reason,old_data,jsonb_build_object('role',_role,'active',_active,'permissions',_permissions)); END; $$;