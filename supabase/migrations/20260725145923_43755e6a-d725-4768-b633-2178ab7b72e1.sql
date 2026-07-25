
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'high_king';

CREATE OR REPLACE FUNCTION public.role_level(_role app_role)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN CASE _role::text
    WHEN 'high_king'   THEN 1000
    WHEN 'super_admin' THEN 100
    WHEN 'admin'       THEN 80
    WHEN 'operator'    THEN 50
    WHEN 'user'        THEN 10
    ELSE 0
  END;
END;
$function$;
