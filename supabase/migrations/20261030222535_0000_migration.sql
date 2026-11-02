
create type public.app_role as enum ('admin','salesman');
create type public.imei_status as enum ('in_stock','with_salesman','sold','damaged');
create type public.move_kind as enum ('issue','sale','return','damage');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique(user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.user_roles where user_id=_user_id and role=_role)
$$;

create policy "own role read" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "profiles read" on public.profiles for select to authenticated using (id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "profiles update" on public.profiles for update to authenticated using (id = auth.uid() or public.has_role(auth.uid(),'admin'));

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, full_name, phone)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), new.raw_user_meta_data->>'phone');
  if not exists (select 1 from public.user_roles where role='admin') then
    insert into public.user_roles(user_id, role) values (new.id,'admin');
  else
    insert into public.user_roles(user_id, role) values (new.id,'salesman');
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  model text,
  price numeric(12,2) not null default 0,
  is_smartphone boolean not null default true,
  stock_qty integer not null default 0,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.products to authenticated;
grant all on public.products to service_role;
alter table public.products enable row level security;
create policy "products read" on public.products for select to authenticated using (true);
create policy "products admin write" on public.products for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table public.imei_units (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  imei text not null unique,
  status imei_status not null default 'in_stock',
  salesman_id uuid,
  retailer_id uuid,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.imei_units to authenticated;
grant all on public.imei_units to service_role;
alter table public.imei_units enable row level security;
create policy "imei read" on public.imei_units for select to authenticated using (public.has_role(auth.uid(),'admin') or salesman_id = auth.uid());
create policy "imei admin write" on public.imei_units for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table public.retailers (
  id uuid primary key default gen_random_uuid(),
  salesman_id uuid not null default auth.uid(),
  name text not null,
  phone text,
  address text,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.retailers to authenticated;
grant all on public.retailers to service_role;
alter table public.retailers enable row level security;
create policy "retailers read" on public.retailers for select to authenticated using (public.has_role(auth.uid(),'admin') or salesman_id = auth.uid());
create policy "retailers insert" on public.retailers for insert to authenticated with check (salesman_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "retailers update" on public.retailers for update to authenticated using (salesman_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  salesman_id uuid not null,
  retailer_id uuid not null references public.retailers(id),
  total numeric(12,2) not null default 0,
  paid numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);
grant select on public.sales to authenticated;
grant all on public.sales to service_role;
alter table public.sales enable row level security;
create policy "sales read" on public.sales for select to authenticated using (public.has_role(auth.uid(),'admin') or salesman_id = auth.uid());

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  salesman_id uuid not null,
  product_id uuid not null references public.products(id),
  kind move_kind not null,
  qty integer not null,
  unit_price numeric(12,2) not null default 0,
  imei text,
  sale_id uuid references public.sales(id),
  retailer_id uuid references public.retailers(id),
  created_at timestamptz not null default now()
);
grant select on public.stock_movements to authenticated;
grant all on public.stock_movements to service_role;
alter table public.stock_movements enable row level security;
create policy "moves read" on public.stock_movements for select to authenticated using (public.has_role(auth.uid(),'admin') or salesman_id = auth.uid());

create table public.retailer_payments (
  id uuid primary key default gen_random_uuid(),
  salesman_id uuid not null default auth.uid(),
  retailer_id uuid not null references public.retailers(id),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now()
);
grant select, insert on public.retailer_payments to authenticated;
grant all on public.retailer_payments to service_role;
alter table public.retailer_payments enable row level security;
create policy "rp read" on public.retailer_payments for select to authenticated using (public.has_role(auth.uid(),'admin') or salesman_id = auth.uid());
create policy "rp insert" on public.retailer_payments for insert to authenticated with check (salesman_id = auth.uid());

create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  salesman_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  note text,
  received_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
grant select, insert on public.deposits to authenticated;
grant all on public.deposits to service_role;
alter table public.deposits enable row level security;
create policy "dep read" on public.deposits for select to authenticated using (public.has_role(auth.uid(),'admin') or salesman_id = auth.uid());
create policy "dep insert" on public.deposits for insert to authenticated with check (public.has_role(auth.uid(),'admin'));

-- scanner validation
create or replace function public.check_imei(_imei text, _mode text, _salesman uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u record; p record;
begin
  select * into u from imei_units where imei = trim(_imei);
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  select * into p from products where id = u.product_id;
  if _mode = 'issue' and u.status <> 'in_stock' then
    return jsonb_build_object('ok',false,'reason','not_in_stock','status',u.status);
  elsif _mode in ('sale','return') and (u.status <> 'with_salesman' or u.salesman_id <> _salesman) then
    return jsonb_build_object('ok',false,'reason','not_with_salesman','status',u.status);
  end if;
  if not (public.has_role(auth.uid(),'admin') or _salesman = auth.uid()) then
    return jsonb_build_object('ok',false,'reason','forbidden');
  end if;
  return jsonb_build_object('ok',true,'product_id',p.id,'product_name',p.name,'price',p.price,'imei',u.imei);
end $$;

create or replace function public.holding_qty(_salesman uuid, _product uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when kind='issue' then qty else -qty end),0)::int
  from stock_movements where salesman_id=_salesman and product_id=_product
$$;

-- issue: items = [{product_id, qty, imeis:[...]}]
create or replace function public.issue_stock(_salesman uuid, _items jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare it jsonb; p record; im text; n int;
begin
  if not public.has_role(auth.uid(),'admin') then raise exception 'admin only'; end if;
  for it in select * from jsonb_array_elements(_items) loop
    select * into p from products where id = (it->>'product_id')::uuid for update;
    if p.is_smartphone then
      for im in select jsonb_array_elements_text(it->'imeis') loop
        update imei_units set status='with_salesman', salesman_id=_salesman
          where imei=im and product_id=p.id and status='in_stock';
        get diagnostics n = row_count;
        if n = 0 then raise exception 'IMEI % not available', im; end if;
        insert into stock_movements(salesman_id,product_id,kind,qty,unit_price,imei) values(_salesman,p.id,'issue',1,p.price,im);
      end loop;
    else
      n := (it->>'qty')::int;
      if n <= 0 or p.stock_qty < n then raise exception 'Not enough stock for %', p.name; end if;
      update products set stock_qty = stock_qty - n where id=p.id;
      insert into stock_movements(salesman_id,product_id,kind,qty,unit_price) values(_salesman,p.id,'issue',n,p.price);
    end if;
  end loop;
end $$;

-- sale by salesman: items = [{product_id, qty, unit_price, imeis:[...]}]
create or replace function public.record_sale(_retailer uuid, _items jsonb, _paid numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare it jsonb; p record; im text; n int; sid uuid; tot numeric := 0; me uuid := auth.uid(); price numeric;
begin
  if not exists(select 1 from retailers where id=_retailer and salesman_id=me) then raise exception 'retailer not yours'; end if;
  insert into sales(salesman_id,retailer_id,total,paid) values(me,_retailer,0,coalesce(_paid,0)) returning id into sid;
  for it in select * from jsonb_array_elements(_items) loop
    select * into p from products where id=(it->>'product_id')::uuid;
    price := coalesce((it->>'unit_price')::numeric, p.price);
    if p.is_smartphone then
      for im in select jsonb_array_elements_text(it->'imeis') loop
        update imei_units set status='sold', retailer_id=_retailer
          where imei=im and product_id=p.id and status='with_salesman' and salesman_id=me;
        get diagnostics n = row_count;
        if n=0 then raise exception 'IMEI % not with you', im; end if;
        insert into stock_movements(salesman_id,product_id,kind,qty,unit_price,imei,sale_id,retailer_id) values(me,p.id,'sale',1,price,im,sid,_retailer);
        tot := tot + price;
      end loop;
    else
      n := (it->>'qty')::int;
      if n<=0 or public.holding_qty(me,p.id) < n then raise exception 'Not enough % in hand', p.name; end if;
      insert into stock_movements(salesman_id,product_id,kind,qty,unit_price,sale_id,retailer_id) values(me,p.id,'sale',n,price,sid,_retailer);
      tot := tot + price*n;
    end if;
  end loop;
  if _paid > tot then raise exception 'paid more than total'; end if;
  update sales set total=tot where id=sid;
  return sid;
end $$;

-- return to dealer (admin receives): items=[{product_id, qty, imeis:[...], damaged:bool}]
create or replace function public.return_stock(_salesman uuid, _items jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare it jsonb; p record; im text; n int; dmg boolean;
begin
  if not (public.has_role(auth.uid(),'admin') or _salesman = auth.uid()) then raise exception 'forbidden'; end if;
  for it in select * from jsonb_array_elements(_items) loop
    select * into p from products where id=(it->>'product_id')::uuid for update;
    dmg := coalesce((it->>'damaged')::boolean,false);
    if p.is_smartphone then
      for im in select jsonb_array_elements_text(it->'imeis') loop
        update imei_units set status = case when dmg then 'damaged'::imei_status else 'in_stock'::imei_status end,
          salesman_id = null
          where imei=im and product_id=p.id and status='with_salesman' and salesman_id=_salesman;
        get diagnostics n=row_count;
        if n=0 then raise exception 'IMEI % not with this salesman', im; end if;
        insert into stock_movements(salesman_id,product_id,kind,qty,unit_price,imei) values(_salesman,p.id, case when dmg then 'damage'::move_kind else 'return'::move_kind end,1,p.price,im);
      end loop;
    else
      n := (it->>'qty')::int;
      if n<=0 or public.holding_qty(_salesman,p.id) < n then raise exception 'Return more than held for %', p.name; end if;
      if not dmg then update products set stock_qty=stock_qty+n where id=p.id; end if;
      insert into stock_movements(salesman_id,product_id,kind,qty,unit_price) values(_salesman,p.id, case when dmg then 'damage'::move_kind else 'return'::move_kind end,n,p.price);
    end if;
  end loop;
end $$;

grant execute on function public.check_imei(text,text,uuid), public.holding_qty(uuid,uuid), public.issue_stock(uuid,jsonb), public.record_sale(uuid,jsonb,numeric), public.return_stock(uuid,jsonb) to authenticated;
