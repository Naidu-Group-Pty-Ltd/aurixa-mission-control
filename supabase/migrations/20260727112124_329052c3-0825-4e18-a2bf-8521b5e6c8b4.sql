UPDATE public.security_intake_sources
SET hmac_secret = encode(gen_random_bytes(48), 'hex')
WHERE (metadata->>'built_in')::boolean = true
  AND (hmac_secret IS NULL OR hmac_secret = '');