alter type public.notification_kind add value if not exists 'security_report_submitted';
alter type public.notification_kind add value if not exists 'security_finding_created';
alter type public.notification_kind add value if not exists 'security_retest_requested';
alter type public.notification_kind add value if not exists 'security_assessment_closed';