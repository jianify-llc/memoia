ALTER TABLE "memoia"."memory_operations" DROP CONSTRAINT "memory_operations_kind_check";--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" DROP CONSTRAINT "memory_operations_status_check";--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" ADD COLUMN "fact_flush_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_fact_import_flush" ON "memoia"."memory_operations" USING btree ("fact_flush_id") WHERE fact_flush_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" ADD CONSTRAINT "memory_operations_kind_check" CHECK ((kind)::text = ANY (ARRAY[('import'::character varying)::text, ('retract'::character varying)::text, ('correct'::character varying)::text, ('legacy_import'::character varying)::text, ('flush'::character varying)::text, ('fact_flush'::character varying)::text]));--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" ADD CONSTRAINT "memory_operations_status_check" CHECK ((status)::text = ANY (ARRAY[('processing'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('staged'::character varying)::text]));
--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" DROP CONSTRAINT "ck_memory_flush_lease";--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" ADD CONSTRAINT "ck_memory_flush_lease" CHECK (((lease_owner IS NULL) = (lease_until IS NULL)) AND (attempts BETWEEN 0 AND 4) AND (kind = 'flush' OR (lease_owner IS NULL AND ((kind = 'import' AND fact_flush_id IS NOT NULL) OR (attempts = 0 AND available_at IS NULL)))));--> statement-breakpoint
COMMENT ON COLUMN memoia.memory_operations.fact_flush_id IS '固定本 Blob 的 Fact 封批操作 ID';
