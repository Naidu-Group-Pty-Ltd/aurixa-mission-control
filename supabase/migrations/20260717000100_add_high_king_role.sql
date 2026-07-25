-- The High King seat: a singular sovereign tier above super_admin.
-- Enum values must be committed before they can be referenced, so this
-- migration only adds the value; the hierarchy rewiring follows in the
-- next migration.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'high_king' BEFORE 'super_admin';
