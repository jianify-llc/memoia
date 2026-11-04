ALTER TABLE "memoia"."queue_tasks" DROP CONSTRAINT "queue_task_terminal";--> statement-breakpoint
ALTER TABLE "memoia"."queue_tasks" ADD CONSTRAINT "queue_task_terminal" CHECK ((("memoia"."queue_tasks"."status" IN ('succeeded','failed'))=("memoia"."queue_tasks"."finished_at" IS NOT NULL)) OR ("memoia"."queue_tasks"."status" IN ('succeeded','failed') AND "memoia"."queue_tasks"."execution_ms" IS NULL AND "memoia"."queue_tasks"."first_started_at" IS NULL));
-- RLS: retain the existing backend-only memoia table permissions.
COMMENT ON COLUMN memoia.queue_tasks.finished_at IS '任务真正结束时间；历史无法还原时为空，禁止用迁移时间冒充';
