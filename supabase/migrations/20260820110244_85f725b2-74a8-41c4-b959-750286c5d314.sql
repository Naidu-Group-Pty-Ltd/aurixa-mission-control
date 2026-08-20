REVOKE ALL ON FUNCTION public.cron_delivery_health(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_delivery_health(INT) TO service_role;