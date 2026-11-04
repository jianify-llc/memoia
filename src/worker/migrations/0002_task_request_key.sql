ALTER TABLE "memoia"."queue_tasks" ADD CONSTRAINT "queue_tasks_request_key_key" UNIQUE("request_key");
-- RLS: the existing memoia internal table remains inaccessible to anonymous Data API roles.
