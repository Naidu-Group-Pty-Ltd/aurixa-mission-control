ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'crm_sla_breach';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'crm_renewal_due';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'crm_retention_due';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'crm_task_assigned';