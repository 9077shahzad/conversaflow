-- 0030 Template updates applied in order (review of slice 3, finding 5). Meta does not guarantee delivery order, so
-- an older review, quality or category update that arrives late must not overwrite a newer one. The time of the last
-- applied update of each kind is kept, and older ones are recorded but ignored.
ALTER TABLE message_templates ADD COLUMN status_event_at timestamptz;
ALTER TABLE message_templates ADD COLUMN quality_event_at timestamptz;
ALTER TABLE message_templates ADD COLUMN category_event_at timestamptz;
GRANT UPDATE (status_event_at, quality_event_at, category_event_at) ON message_templates TO cf_app;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_outcome_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_outcome_check
  CHECK (outcome IN ('applied', 'stale_status', 'orphan_status', 'unknown_template', 'stale_template'));
