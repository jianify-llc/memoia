UPDATE memoia.usage_counters
SET expires_at = CASE period_type
  WHEN 'day' THEN period_start + interval '30 days'
  WHEN 'month' THEN period_start + interval '1 month'
END
WHERE expires_at IS DISTINCT FROM CASE period_type
  WHEN 'day' THEN period_start + interval '30 days'
  WHEN 'month' THEN period_start + interval '1 month'
END;
