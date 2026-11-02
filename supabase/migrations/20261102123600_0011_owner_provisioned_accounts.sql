CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  has_owner boolean;
  provisioning text := new.raw_app_meta_data ->> 'provisioning';
BEGIN
  INSERT INTO public.profiles(id, full_name, phone)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.raw_user_meta_data ->> 'phone'
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE role = 'admin'
  ) INTO has_owner;

  IF NOT has_owner AND provisioning = 'initial_owner' THEN
    INSERT INTO public.user_roles(user_id, role) VALUES (new.id, 'admin');
  ELSIF has_owner AND provisioning = 'owner_created_salesman' THEN
    INSERT INTO public.user_roles(user_id, role) VALUES (new.id, 'salesman');
  ELSE
    RAISE EXCEPTION 'User accounts must be provisioned by the project owner';
  END IF;

  RETURN new;
END;
$$;
